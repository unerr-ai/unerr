/**
 * Sprint P2-1: Rule-based intent scorer.
 *
 * Produces a probability distribution over server families based on
 * session signals. The gateway uses scores to decide which families
 * to expose/mask. Deterministic, no LLM call, <5ms hard budget.
 *
 * Signal sources (ordered by weight):
 *   1. Entity family tags (from import-graph walking) — weight: 0.45
 *   2. Recent file paths (from family-detector) — weight: 0.35
 *   3. Recent tool calls by family — weight: 0.30
 *   4. Stickiness (used in last 5 turns) — forced exposure
 *   5. Threshold decay (per-repo history) — adjusts threshold per family
 *
 * Multi-domain detection: if ≥2 families score ≥0.4, expose all of them.
 * This avoids wrong-masking on mixed prompts (e.g., DB + GitHub context).
 *
 * Latency budget: hard 5ms cap. If exceeded, log + expose all (fail-open).
 */

import { detectFamilies } from "../family-detector.js";
import { type StickinessState, isSticky } from "./stickiness.js";
import { getAdjustedThreshold, type DecayState } from "./threshold-decay.js";

export interface IntentScore {
  readonly family: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly sticky: boolean;
  readonly thresholdApplied: number;
  readonly exposed: boolean;
}

export interface ScorerInput {
  readonly recentFiles: readonly string[];
  readonly entityFamilyTags: ReadonlyMap<string, ReadonlySet<string>>;
  readonly recentToolFamilies: readonly string[];
  readonly stickinessState: StickinessState;
  readonly decayState: DecayState;
  readonly knownFamilies: ReadonlySet<string>;
}

export interface ScorerOutput {
  readonly scores: readonly IntentScore[];
  readonly exposedFamilies: ReadonlySet<string>;
  readonly multiDomain: boolean;
  readonly latencyMs: number;
  readonly budgetExceeded: boolean;
}

const HARD_BUDGET_MS = 5;
const ENTITY_TAG_WEIGHT = 0.45;
const FILE_PATTERN_WEIGHT = 0.50;
const TOOL_HISTORY_WEIGHT = 0.30;
const DEFAULT_THRESHOLD = 0.30;
const MULTI_DOMAIN_THRESHOLD = 0.40;
const MULTI_DOMAIN_MIN_FAMILIES = 2;

/**
 * Score all known families based on current session signals.
 *
 * Returns scored families with exposure decisions. Families scoring
 * above their threshold (adjusted by decay) are exposed. Sticky
 * families are always exposed regardless of score.
 *
 * Multi-domain: if ≥2 families score ≥0.4, ALL of those families
 * are exposed regardless of individual thresholds.
 */
export function scoreIntent(input: ScorerInput): ScorerOutput {
  const start = performance.now();

  const familyScores = new Map<string, { score: number; reasons: string[] }>();

  for (const family of input.knownFamilies) {
    familyScores.set(family, { score: 0, reasons: [] });
  }

  // ── Signal 1: Entity family tags (highest confidence) ──────────
  for (const [entityName, tags] of input.entityFamilyTags) {
    for (const tag of tags) {
      const entry = familyScores.get(tag);
      if (entry) {
        if (ENTITY_TAG_WEIGHT > entry.score) {
          entry.score = ENTITY_TAG_WEIGHT;
        }
        if (!entry.reasons.some((r) => r.includes("import-graph"))) {
          entry.reasons.push(`import-graph: ${entityName} imports ${tag}-family library`);
        }
      }
    }
  }

  // ── Signal 2: File path patterns ───────────────────────────────
  if (input.recentFiles.length > 0) {
    const detection = detectFamilies(input.recentFiles, input.knownFamilies);
    for (const signal of detection.signals) {
      const entry = familyScores.get(signal.family);
      if (entry) {
        const pathScore = signal.score * FILE_PATTERN_WEIGHT;
        if (pathScore > entry.score) {
          entry.score = pathScore;
          entry.reasons.push(`file pattern: ${signal.reason}`);
        }
      }
    }
  }

  // ── Signal 3: Recent tool call history ─────────────────────────
  if (input.recentToolFamilies.length > 0) {
    const familyCounts = new Map<string, number>();
    for (const f of input.recentToolFamilies) {
      familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
    }
    const maxCount = Math.max(...familyCounts.values());

    for (const [family, count] of familyCounts) {
      const entry = familyScores.get(family);
      if (entry) {
        const toolScore = (count / maxCount) * TOOL_HISTORY_WEIGHT;
        if (toolScore > entry.score) {
          entry.score = toolScore;
          entry.reasons.push(`recent tool calls: ${count}× in last ${input.recentToolFamilies.length} calls`);
        }
      }
    }
  }

  // ── Multi-domain detection ─────────────────────────────────────
  const highScoreFamilies: string[] = [];
  for (const [family, { score }] of familyScores) {
    if (score >= MULTI_DOMAIN_THRESHOLD) {
      highScoreFamilies.push(family);
    }
  }
  const multiDomain = highScoreFamilies.length >= MULTI_DOMAIN_MIN_FAMILIES;

  // ── Build final scores with stickiness + decay ─────────────────
  const scores: IntentScore[] = [];
  const exposedFamilies = new Set<string>();

  for (const [family, { score, reasons }] of familyScores) {
    const sticky = isSticky(family, input.stickinessState);
    const threshold = getAdjustedThreshold(family, input.decayState, DEFAULT_THRESHOLD);

    let exposed: boolean;
    if (multiDomain && highScoreFamilies.includes(family)) {
      exposed = true;
      if (!reasons.some((r) => r.includes("multi-domain"))) {
        reasons.push(`multi-domain: ${highScoreFamilies.length} families scored ≥${MULTI_DOMAIN_THRESHOLD}`);
      }
    } else {
      exposed = sticky || score >= threshold;
    }

    if (sticky && !reasons.some((r) => r.includes("sticky"))) {
      reasons.push(`sticky: used in last 5 turns`);
    }

    scores.push({
      family,
      score,
      reasons,
      sticky,
      thresholdApplied: threshold,
      exposed,
    });

    if (exposed) {
      exposedFamilies.add(family);
    }
  }

  scores.sort((a, b) => b.score - a.score);

  const latencyMs = performance.now() - start;
  const budgetExceeded = latencyMs > HARD_BUDGET_MS;

  if (budgetExceeded) {
    for (const family of input.knownFamilies) {
      exposedFamilies.add(family);
    }
  }

  return {
    scores,
    exposedFamilies,
    multiDomain,
    latencyMs,
    budgetExceeded,
  };
}
