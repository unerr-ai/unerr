/**
 * Signal Scorer — ranks intelligence signals by composite score.
 *
 * Replaces the flat 15-field _context dump with a ranked signals[] array.
 * Each signal is scored: composite = actionability^1.5 * relevance * confidence.
 * The actionability exponent (1.5) biases toward signals agents can act on.
 *
 * Part of Layer A+B of the Three-Layer Experience System.
 */

/** Signal types ordered by urgency */
export type SignalType = "warning" | "guidance" | "context" | "history";

/**
 * Per-type rotation decay: how aggressively a signal's effective rank drops
 * with each show. Warnings (anti-patterns, risks) keep surfacing even after
 * the agent has seen them; history (low-actionability) fades fast.
 *
 * effective_score = composite_score / (1 + shows × decay)
 */
const SIGNAL_TYPE_DECAY: Record<SignalType, number> = {
  warning: 0.3,
  guidance: 0.4,
  context: 0.5,
  history: 0.8,
};

/** Source of the intelligence signal */
export type SignalSource = "graph" | "temporal" | "graph+temporal";

/** A scored, ranked intelligence signal — carried on internal `context.signals` and drained to `ur|<tag>` prefix lines by buildSignalPrefix(). */
export interface IntelligenceSignal {
  /** Signal urgency category */
  type: SignalType;
  /** Human-readable signal text */
  content: string;
  /** Suggested action (undefined for informational signals) */
  action?: string;
  /** 0-1: how actionable is this signal? */
  actionability: number;
  /** 0-1: how relevant to the current tool call? */
  relevance: number;
  /** 0-1: how confident are we in this signal? */
  confidence: number;
  /** Computed: actionability^1.5 * relevance * confidence */
  composite_score: number;
  /** Where the signal originates */
  source: SignalSource;
}

/** Decision level determines how many signals to surface */
export type DecisionLevel = "high" | "medium" | "low";

/**
 * Stable ID for a signal, used by the rotational-decay tracker in SessionContext.
 * Uses content hash so the same fact surfaced twice gets the same id even if
 * the signal envelope (action/source) varies slightly between calls.
 */
export function signalId(s: IntelligenceSignal): string {
  // Lightweight FNV-1a 32-bit hash, hex-encoded; 8 chars is enough collision
  // resistance for in-session dedup (we expect <500 unique signals/session).
  const str = `${s.type}|${s.content}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Raw context fields collected during enrichResult gathering phase */
export interface RawContextData {
  blast_radius?: string;
  pending_violations?: Array<{
    file: string;
    rule: string;
    message: string;
    line?: number;
  }>;
  drift_alert?: string;
  durability_warning?: string;
  corrections?: string[];
  anti_patterns?: string[];
  conventions?: string[];
  learned_conventions?: string[];
  relevant_facts?: string[];
  community?: string;
  reminder?: string;
  history?: string[];
  prompt_strategy?: string[];
  co_changes?: string;
  hidden_coupling?: string;
}

/**
 * Compute the composite score for a signal.
 * Formula: actionability^1.5 * relevance * confidence
 */
function computeComposite(
  actionability: number,
  relevance: number,
  confidence: number
): number {
  return actionability ** 1.5 * relevance * confidence;
}

/**
 * Create a signal with auto-computed composite score.
 */
function createSignal(
  params: Omit<IntelligenceSignal, "composite_score">
): IntelligenceSignal {
  return {
    ...params,
    composite_score: computeComposite(
      params.actionability,
      params.relevance,
      params.confidence
    ),
  };
}

export class SignalScorer {
  /**
   * Convert raw gathered context fields into scored IntelligenceSignals.
   * Each field maps to a signal type with default actionability scores.
   */
  contextToSignals(
    raw: RawContextData,
    _toolName: string,
    _args: Record<string, unknown>
  ): IntelligenceSignal[] {
    const signals: IntelligenceSignal[] = [];

    // ── Warnings (highest actionability) ──

    if (raw.blast_radius) {
      signals.push(
        createSignal({
          type: "warning",
          content: raw.blast_radius,
          action: "call get_references({direction:'callers'}) before editing",
          actionability: 0.9,
          relevance: 0.85,
          confidence: 0.95,
          source: "graph",
        })
      );
    }

    if (raw.pending_violations && raw.pending_violations.length > 0) {
      for (const v of raw.pending_violations.slice(0, 3)) {
        signals.push(
          createSignal({
            type: "warning",
            content: `Rule violation in ${v.file}: ${v.message}`,
            action: `Fix: ${v.rule}${v.line ? ` at line ${v.line}` : ""}`,
            actionability: 1.0,
            relevance: 0.95,
            confidence: 0.9,
            source: "graph",
          })
        );
      }
    }

    if (raw.drift_alert) {
      signals.push(
        createSignal({
          type: "warning",
          content: raw.drift_alert,
          action:
            "call get_references({direction:'callers'}); diff each caller against drift_overlay before edit",
          actionability: 0.9,
          relevance: 0.9,
          confidence: 0.85,
          source: "graph",
        })
      );
    }

    if (raw.durability_warning) {
      signals.push(
        createSignal({
          type: "warning",
          content: raw.durability_warning,
          action:
            "emit `unerr journal - stuck - <obstacle>` in your closing message before retrying; propose an alternative approach (high revert rate signals the prior approach won't stick)",
          actionability: 0.85,
          relevance: 0.8,
          confidence: 0.75,
          source: "temporal",
        })
      );
    }

    if (raw.corrections) {
      for (const c of raw.corrections.slice(0, 2)) {
        signals.push(
          createSignal({
            type: "warning",
            content: c,
            // Echo the corrected pattern itself so the model has a literal
            // constraint, not a deictic 'this pattern' to resolve.
            action: `do not reintroduce: ${c}`,
            actionability: 0.8,
            relevance: 0.75,
            confidence: 0.7,
            source: "temporal",
          })
        );
      }
    }

    if (raw.anti_patterns) {
      for (const ap of raw.anti_patterns.slice(0, 2)) {
        signals.push(
          createSignal({
            type: "warning",
            content: ap,
            // Imperative tail so the agent treats the anti-pattern as a
            // constraint on next-turn output, not a passive observation.
            action: "do not introduce in new code",
            actionability: 0.8,
            relevance: 0.75,
            confidence: 0.8,
            source: "temporal",
          })
        );
      }
    }

    // ── Guidance (medium actionability) ──

    if (raw.conventions) {
      for (const conv of raw.conventions.slice(0, 3)) {
        signals.push(
          createSignal({
            type: "guidance",
            content: conv,
            actionability: 0.7,
            relevance: 0.65,
            confidence: 0.8,
            source: "graph",
          })
        );
      }
    }

    if (raw.learned_conventions) {
      for (const lc of raw.learned_conventions.slice(0, 2)) {
        signals.push(
          createSignal({
            type: "guidance",
            content: lc,
            actionability: 0.65,
            relevance: 0.6,
            confidence: 0.7,
            source: "temporal",
          })
        );
      }
    }

    if (raw.prompt_strategy) {
      for (const ps of raw.prompt_strategy.slice(0, 2)) {
        signals.push(
          createSignal({
            type: "guidance",
            content: ps,
            actionability: 0.6,
            relevance: 0.55,
            confidence: 0.65,
            source: "temporal",
          })
        );
      }
    }

    // ── Context (lower actionability) ──

    if (raw.relevant_facts) {
      for (const fact of raw.relevant_facts.slice(0, 3)) {
        // Per-fact-type tuning. Anti-drift signals (negative, convention) need
        // to outrank co-change `hnt` even at low decision level (cap=2).
        // Without this, project-scoped conventions like
        // "All API handlers must return _meta" get edged out of the prefix
        // slot on file_reads — exactly the bug reported in Issue #4.
        const isEpisodic = fact.startsWith("[episodic]");
        const isNegative = fact.startsWith("[negative]");
        const isConvention = fact.startsWith("[convention]");
        const isSemantic = fact.startsWith("[semantic]");
        let type: SignalType;
        let actionability: number;
        let relevance: number;
        if (isEpisodic) {
          type = "history";
          actionability = 0.7;
          relevance = 0.6;
        } else if (isNegative) {
          type = "warning";
          actionability = 0.85; // ↑ from 0.8 — anti-pattern facts must always rank
          relevance = 0.75;
        } else if (isConvention) {
          type = "context";
          actionability = 0.75; // NEW — outranks co-change hnt
          relevance = 0.75;
        } else if (isSemantic) {
          type = "context";
          actionability = 0.55;
          relevance = 0.6;
        } else {
          type = "context";
          actionability = 0.5; // procedural / default
          relevance = 0.5;
        }
        signals.push(
          createSignal({
            type,
            content: fact,
            // Concrete next-action per fact subtype. No hedge verbs.
            action: isEpisodic
              ? "read narrative above before editing; emit `unerr journal - decided - <choice>` in your closing message if diverging from the prior intent"
              : isConvention
                ? "apply the convention above to new code in this scope"
                : undefined,
            actionability,
            relevance,
            confidence: 0.7, // ↑ from 0.65 — facts are first-class data
            source: "temporal",
          })
        );
      }
    }

    if (raw.community) {
      signals.push(
        createSignal({
          type: "context",
          content: raw.community,
          action:
            "call get_references({key:'<entity>', direction:'callers'}) to walk cluster members",
          actionability: 0.4,
          relevance: 0.5,
          confidence: 0.85,
          source: "graph",
        })
      );
    }

    if (raw.reminder) {
      // Intentionally action-less: `raw.reminder` is a pre-formed advisory
      // string with no structured next-step. Low actionability (0.3) ranks
      // it below load-bearing signals, so it only surfaces when nothing
      // better exists. Anti-pattern rule (CLAUDE.md): a signal without an
      // action is noise — accepted here because the content itself is a
      // self-contained reminder, not a deferred imperative.
      signals.push(
        createSignal({
          type: "context",
          content: raw.reminder,
          actionability: 0.3,
          relevance: 0.5,
          confidence: 0.9,
          source: "graph",
        })
      );
    }

    // ── Co-change prediction (graph+temporal) ──

    if (raw.co_changes) {
      signals.push(
        createSignal({
          type: "guidance",
          content: raw.co_changes,
          // Avoid deictic 'this file' — the partners are already named in
          // content; instruct the agent to open them before editing.
          action: "open the listed files before editing either",
          actionability: 0.6,
          relevance: 0.7,
          confidence: 0.7,
          source: "graph+temporal",
        })
      );
    }

    // ── Hidden coupling (temporal-only dependency) ──

    if (raw.hidden_coupling) {
      signals.push(
        createSignal({
          type: "warning",
          content: raw.hidden_coupling,
          // Coupled entity is named in `content`; instruct a concrete read.
          action:
            "read the coupled entity via search_code({query:'<coupled entity>', detail:true}) before edit",
          actionability: 0.85,
          relevance: 0.8,
          confidence: 0.7,
          source: "graph+temporal",
        })
      );
    }

    // ── History (lowest actionability) ──

    if (raw.history) {
      for (const h of raw.history.slice(0, 2)) {
        signals.push(
          createSignal({
            type: "history",
            content: h,
            actionability: 0.3,
            relevance: 0.4,
            confidence: 0.6,
            source: "temporal",
          })
        );
      }
    }

    return signals;
  }

  /**
   * Apply burst multipliers for high decision points.
   * At edit time, warnings and history crowd out informational signals.
   */
  applyBurstMultipliers(
    signals: IntelligenceSignal[],
    decisionLevel: DecisionLevel
  ): IntelligenceSignal[] {
    if (decisionLevel !== "high") return signals;

    return signals.map((s) => {
      let relevanceBoost = 1.0;

      if (s.type === "warning") {
        // Blast radius / corrections get boosted at edit time
        relevanceBoost = 1.3;
      } else if (s.type === "history") {
        // Episodic facts about prior modifications are most valuable pre-edit
        relevanceBoost = 1.5;
      } else if (s.type === "guidance" && s.source === "temporal") {
        // Learned conventions slightly boosted
        relevanceBoost = 1.1;
      }

      if (relevanceBoost === 1.0) return s;

      const boostedRelevance = Math.min(1.0, s.relevance * relevanceBoost);
      return {
        ...s,
        relevance: boostedRelevance,
        composite_score: computeComposite(
          s.actionability,
          boostedRelevance,
          s.confidence
        ),
      };
    });
  }

  /**
   * Rank signals by composite score (descending) and return top N.
   *
   * Tier-3 rotational decay: when `getShowCount` is provided, the effective
   * score is `composite_score / (1 + showCount * 0.5)`. After 3 shows the
   * effective score halves; after 6 it's quartered. Higher-confidence signals
   * still surface (their base score wins) but eventually rotate to give
   * fresher content airtime instead of repeating the same anti-pattern fact.
   *
   * Wire-dedup awareness: when `wouldEmit` is provided, signals that would be
   * suppressed at the wire boundary (already-emitted, same-content) are
   * filtered out *before* ranking — preventing them from consuming scarce
   * rank slots and starving genuinely fresh signals.
   */
  rank(
    signals: IntelligenceSignal[],
    maxSignals = 3,
    getShowCount?: (signalId: string) => number,
    wouldEmit?: (signal: IntelligenceSignal) => boolean
  ): IntelligenceSignal[] {
    if (signals.length === 0) return [];

    const filtered = wouldEmit ? signals.filter((s) => wouldEmit(s)) : signals;
    if (filtered.length === 0) return [];

    const adjusted = filtered.map((s) => {
      const id = signalId(s);
      const shows = getShowCount ? getShowCount(id) : 0;
      const decay = SIGNAL_TYPE_DECAY[s.type] ?? 0.5;
      const effectiveScore = s.composite_score / (1 + shows * decay);
      return { signal: s, id, effectiveScore };
    });

    return adjusted
      .sort((a, b) => b.effectiveScore - a.effectiveScore)
      .slice(0, maxSignals)
      .map(({ signal }, i) => ({ ...signal, priority: i + 1 }));
  }

  /**
   * Convert raw convention to prescriptive signal.
   * For search_code({detail:true})/file_read: "Follow [pattern] for new [kind]s — 87% adherence"
   * For get_conventions: keep descriptive (agent asked for overview)
   */
  conventionToSignal(
    convention: {
      name: string;
      rule: string;
      adherence_pct: number;
      kind: string;
    },
    toolName: string
  ): IntelligenceSignal {
    const isPrescriptive = toolName !== "get_conventions";
    return createSignal({
      type: "guidance",
      content: isPrescriptive
        ? `Follow "${convention.name}" for new ${convention.kind}s \u2014 ${convention.adherence_pct}% adherence in this project`
        : `${convention.name}: ${convention.rule} (${convention.adherence_pct}% adherence)`,
      action: isPrescriptive ? `Apply pattern: ${convention.rule}` : undefined,
      actionability: isPrescriptive ? 0.8 : 0.5,
      relevance: convention.adherence_pct / 100,
      confidence: convention.adherence_pct / 100,
      source: "graph",
    });
  }
}

/** Singleton instance */
let _scorer: SignalScorer | null = null;

export function getSignalScorer(): SignalScorer {
  if (!_scorer) _scorer = new SignalScorer();
  return _scorer;
}
