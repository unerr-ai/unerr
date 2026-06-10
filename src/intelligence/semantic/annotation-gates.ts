/**
 * Parse-time quality gates for Layer 8 domain annotations (§5.2).
 *
 * Core principle: a wrong summary is worse than no summary — the agent
 * trusts it, skips reading the code, and makes confident wrong changes.
 * A failed gate drops or downgrades the annotation; it NEVER blocks the
 * edit or the index. Structural truth is never hostage to semantic hygiene.
 */

import type { ParsedDocComment } from "./docstring-extractor.js";
import { tokenizeIdentifier } from "./identifier-tokenizer.js";

export const PROSE_MIN_WORDS = 3;
export const PROSE_MAX_WORDS = 60;
export const SENTINEL_MAX_CHARS = 120;
/** Applied once when prose names an identifier the graph doesn't know (§5.2). */
export const UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER = 0.7;

export type GateKind =
  | "length"
  | "tautology"
  | "identifier"
  | "vocabulary"
  | "stacking";

export interface GateRejection {
  gate: GateKind;
  detail: string;
}

export interface GateOptions {
  entityName: string;
  /** Graph entity names for the identifier cross-check; omit to skip that gate. */
  knownIdentifiers?: ReadonlySet<string>;
  /** Active domain-tag vocabulary; omit to skip the vocabulary gate. */
  activeDomains?: ReadonlySet<string>;
}

export interface GatedAnnotation {
  /** Prose that survived the gates (possibly truncated). "" when rejected or absent. */
  summary: string;
  /** Sentinel pairs that survived. Empty when the sentinel was rejected or absent. */
  pairs: Record<string, string>;
  /** 1.0, or ×0.7 when prose names an identifier the graph doesn't know. */
  confidenceMultiplier: number;
  /** Domain value not in the active tag set — candidate-new-domain flow (§5.2). */
  candidateDomain: string | null;
  /** Gates that fired, for nudge emission. */
  rejections: GateRejection[];
}

/** Words that carry no signal in the tautology comparison. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
]);

/** Trailing-s stemmer — enough to catch "Validates token" ≈ validateToken. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function proseTokens(prose: string): string[] {
  return prose
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * CamelCase (interior uppercase), snake_case, or SCREAMING_SNAKE identifiers
 * mentioned in prose. Bare all-caps tokens (API, HTTP) are matched by the
 * camel branch but skipped at the call site as acronyms.
 */
const IDENTIFIER_IN_PROSE =
  /\b([A-Za-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g;

/**
 * Apply the §5.2 gates to a parsed doc comment. Pure and total — returns a
 * downgraded annotation rather than throwing, in every failure mode.
 */
export function applyAnnotationGates(
  parsed: ParsedDocComment,
  opts: GateOptions
): GatedAnnotation {
  const rejections: GateRejection[] = [];
  let confidenceMultiplier = 1.0;

  // ── Prose gates (skipped when the block is sentinel-only) ──
  let summary = "";
  if (parsed.prose !== null) {
    const words = parsed.prose.split(/\s+/).filter(Boolean);

    if (words.length < PROSE_MIN_WORDS) {
      rejections.push({
        gate: "length",
        detail: `prose ${words.length} words < ${PROSE_MIN_WORDS} — rejected`,
      });
    } else {
      summary = parsed.prose;
      if (words.length > PROSE_MAX_WORDS) {
        summary = words.slice(0, PROSE_MAX_WORDS).join(" ");
        rejections.push({
          gate: "length",
          detail: `prose truncated ${words.length}→${PROSE_MAX_WORDS} words`,
        });
      }

      // Tautology: prose that only restates the entity name carries no signal.
      const nameTokens = new Set(tokenizeIdentifier(opts.entityName).map(stem));
      const contentTokens = proseTokens(summary);
      if (
        contentTokens.length > 0 &&
        contentTokens.every((t) => nameTokens.has(t))
      ) {
        rejections.push({
          gate: "tautology",
          detail: `prose restates entity name ${opts.entityName} — rejected`,
        });
        summary = "";
      }
    }

    // Identifier cross-check: an unknown name in prose may be hallucinated.
    if (summary !== "" && opts.knownIdentifiers !== undefined) {
      for (const match of summary.matchAll(IDENTIFIER_IN_PROSE)) {
        const ident = match[1]!;
        if (ident === opts.entityName) continue;
        // All-caps with no underscore is a prose acronym (API, HTTP, JSON),
        // not an identifier reference. SCREAMING_SNAKE constants keep their
        // underscores and are still checked.
        if (/^[A-Z0-9]+$/.test(ident)) continue;
        if (!opts.knownIdentifiers.has(ident)) {
          confidenceMultiplier = UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER;
          rejections.push({
            gate: "identifier",
            detail: `prose names unknown identifier ${ident} — confidence ×${UNKNOWN_IDENTIFIER_CONFIDENCE_MULTIPLIER}`,
          });
          break;
        }
      }
    }
  }

  // ── Sentinel gates ──
  let pairs: Record<string, string> = {};
  let candidateDomain: string | null = null;
  if (parsed.sentinel !== null) {
    if (parsed.sentinel.lineLength > SENTINEL_MAX_CHARS) {
      rejections.push({
        gate: "length",
        detail: `sentinel line ${parsed.sentinel.lineLength} chars > ${SENTINEL_MAX_CHARS} — rejected`,
      });
    } else {
      pairs = { ...parsed.sentinel.pairs };

      if (parsed.sentinel.stackedCount > 1) {
        rejections.push({
          gate: "stacking",
          detail: `${parsed.sentinel.stackedCount} sentinel lines — first wins, rest rejected`,
        });
      }

      // Vocabulary: unknown domain is kept but flagged as a candidate;
      // promotion happens after 3 entities carry it (SC-C.4).
      const domain = pairs.domain;
      if (
        domain !== undefined &&
        opts.activeDomains !== undefined &&
        !opts.activeDomains.has(domain)
      ) {
        candidateDomain = domain;
      }
    }
  }

  return { summary, pairs, confidenceMultiplier, candidateDomain, rejections };
}
