/**
 * Load-bearing note ranking — the single ordering both note-delivery surfaces
 * share: the per-prompt UserPromptSubmit recall (`prompt-hooks.ts`) and the
 * `unerr_context` recon bundle (`query-router.ts`). A matched-notes set can be
 * large; injecting all of it every turn re-bills uncacheable tokens for notes
 * the turn will not act on. Both surfaces rank by load-bearing score and keep
 * the top slice, so the per-turn footprint stays small while the full set stays
 * reachable through `unerr_context`.
 *
 * Load-bearing here is a deterministic proxy for "actionable + on-topic":
 * stronger note kinds (rule/warn/blocker/decision) outrank facts; file/entity
 * anchors outrank project/glob/workspace anchors; explicit do/don't polarity
 * outranks ambiguous; and lexical overlap with the prompt breaks ties. Pure and
 * stable — equal scores keep input order — so a given set always ranks the same
 * way and the injected block is byte-stable turn to turn.
 *
 * @sem domain=intelligence role=ranker
 */

/** The minimal note shape this ranker scores. `RecalledNote` (recall-client)
 *  and the bundle's note rows both satisfy it structurally. */
export interface RankableNote {
  kind: string;
  anchor: string;
  polarity: string;
  content: string;
}

export interface NoteRankOptions {
  /** Prompt the notes were matched against; drives the lexical-overlap tie-break. */
  prompt?: string;
  /** Max notes to keep. Omit for no cap (rank only). */
  max?: number;
}

/** Default per-turn recall cap — enough to carry the load-bearing notes for a
 *  focused task, small enough that the injection stays a few hundred tokens. */
export const DEFAULT_RECALL_MAX = 4;

// Note-kind weights. Rules/warnings/blockers are constraints the turn must obey;
// decisions record a deliberate choice; conventions guide style; facts are
// context. Unknown kinds score as a weak fact so they still surface, ranked low.
const KIND_WEIGHT: Record<string, number> = {
  rul: 6,
  wrn: 6,
  blk: 5,
  dec: 4,
  cnv: 3,
  fct: 2,
};
const DEFAULT_KIND_WEIGHT = 1;

// Anchor-specificity weights, keyed by the DSL anchor prefix. A file/entity
// anchor names exactly what the edit touches; project/workspace anchors are
// broad background. `g:` (glob) sits between.
const ANCHOR_WEIGHT: Array<[prefix: string, weight: number]> = [
  ["e:", 3],
  ["f:", 3],
  ["g:", 1],
  ["p:", 0],
  ["w:", 0],
];

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "it",
  "this",
  "that",
  "be",
  "as",
  "at",
  "by",
  "from",
  "into",
  "over",
  "but",
  "not",
  "no",
  "do",
  "if",
  "we",
  "you",
  "i",
  "are",
  "was",
  "so",
  "up",
  "out",
]);

function anchorWeight(anchor: string): number {
  for (const [prefix, weight] of ANCHOR_WEIGHT) {
    if (anchor.startsWith(prefix)) return weight;
  }
  return 0;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/**
 * Load-bearing score for one note against an optional prompt. Higher = more
 * likely the turn must act on it. Bounded and deterministic.
 */
export function loadBearingScore(
  note: RankableNote,
  promptTokens?: Set<string>
): number {
  let score = KIND_WEIGHT[note.kind] ?? DEFAULT_KIND_WEIGHT;
  score += anchorWeight(note.anchor);
  // Explicit do (+) / don't (-) polarity is actionable; ambiguous (~) is not.
  if (note.polarity === "+" || note.polarity === "-") score += 1;
  // Lexical overlap with the prompt, capped so a long note can't dominate on
  // verbosity alone. Each distinct shared term is worth 0.5, up to 3.
  if (promptTokens && promptTokens.size > 0) {
    const noteTokens = tokenize(note.content);
    let overlap = 0;
    for (const t of noteTokens) {
      if (promptTokens.has(t)) overlap++;
    }
    score += Math.min(3, overlap * 0.5);
  }
  return score;
}

/**
 * Rank notes by load-bearing score, highest first. Stable: equal scores keep
 * their input order, so a given set always serializes identically.
 */
export function rankLoadBearing<T extends RankableNote>(
  notes: T[],
  prompt?: string
): T[] {
  const promptTokens = prompt ? tokenize(prompt) : undefined;
  return notes
    .map((note, index) => ({
      note,
      index,
      score: loadBearingScore(note, promptTokens),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.note);
}

/**
 * Rank then keep the top `max` (default {@link DEFAULT_RECALL_MAX}). With no
 * `max`, returns the full ranked list. The dropped notes stay reachable via
 * `unerr_context` — this only bounds the per-turn injected slice.
 */
export function selectLoadBearing<T extends RankableNote>(
  notes: T[],
  options: NoteRankOptions = {}
): T[] {
  const ranked = rankLoadBearing(notes, options.prompt);
  const max = options.max ?? DEFAULT_RECALL_MAX;
  return max >= 0 ? ranked.slice(0, max) : ranked;
}
