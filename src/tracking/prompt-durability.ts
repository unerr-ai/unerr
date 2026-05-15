/**
 * Prompt Durability Profiler — analyzes which prompt types produce durable vs fragile code.
 *
 * Classifies ledger entries by action type (add/modify/refactor/fix/delete),
 * target risk level, and file scope. Computes durability per profile bucket
 * and generates recommendations for prompt strategies that historically produce
 * more stable code.
 *
 * Data flow: shadow ledger entries → classification → aggregation → profiles.
 */

import { createModuleLogger } from "../utils/logger.js";

const log = createModuleLogger("prompt-durability");

export interface PromptDurabilityProfile {
  actionType: "add" | "modify" | "refactor" | "fix" | "delete" | "other";
  targetRisk: "critical" | "high" | "medium" | "low";
  scope: "single_file" | "multi_file";
  durability: number;
  sampleCount: number;
  recommendation?: string;
}

interface LedgerEntryLike {
  prompt?: string;
  files?: string[];
  survived?: boolean;
  riskLevel?: string;
}

const ADD_PATTERNS = [
  /\badd(?:ing|ed|s)?\b/i,
  /\bcreate(?:d|s|ing)?\b/i,
  /\bnew\b/i,
  /\bimplement(?:ed|s|ing)?\b/i,
  /\bintroduc(?:e|ed|ing)\b/i,
  /\bbuild(?:ing|s)?\b/i,
  /\bset\s*up\b/i,
];

const MODIFY_PATTERNS = [
  /\bmodif(?:y|ied|ying|ies)\b/i,
  /\bupdate(?:d|s|ing)?\b/i,
  /\bchange(?:d|s|ing)?\b/i,
  /\bedit(?:ed|s|ing)?\b/i,
  /\badjust(?:ed|s|ing)?\b/i,
  /\btweak(?:ed|s|ing)?\b/i,
  /\balter(?:ed|s|ing)?\b/i,
];

const REFACTOR_PATTERNS = [
  /\brefactor(?:ed|s|ing)?\b/i,
  /\brestructur(?:e|ed|ing)\b/i,
  /\breorganiz(?:e|ed|ing)\b/i,
  /\bclean\s*up\b/i,
  /\bextract(?:ed|s|ing)?\b/i,
  /\bmove(?:d|s|ing)?\b/i,
  /\brename(?:d|s|ing)?\b/i,
  /\bsimplif(?:y|ied|ying|ies)\b/i,
];

const FIX_PATTERNS = [
  /\bfix(?:ed|es|ing)?\b/i,
  /\bbug\s*fix\b/i,
  /\bresolv(?:e|ed|ing)\b/i,
  /\brepair(?:ed|s|ing)?\b/i,
  /\bpatch(?:ed|es|ing)?\b/i,
  /\bcorrect(?:ed|s|ing)?\b/i,
  /\bhandle\b.*\berror\b/i,
  /\bworkaround\b/i,
];

const DELETE_PATTERNS = [
  /\bdelete(?:d|s|ing)?\b/i,
  /\bremove(?:d|s|ing)?\b/i,
  /\bdrop(?:ped|s|ping)?\b/i,
  /\bstrip(?:ped|s|ping)?\b/i,
  /\bdeprecate(?:d|s|ing)?\b/i,
  /\beliminate(?:d|s|ing)?\b/i,
];

/**
 * Classifies a prompt string into an action type based on keyword patterns.
 *
 * Priority order: fix > refactor > delete > add > modify > other.
 * Fix is highest priority because fix prompts often also contain "modify" or "change".
 */
export function extractActionType(
  prompt: string
): PromptDurabilityProfile["actionType"] {
  if (!prompt || prompt.trim().length === 0) return "other";

  if (FIX_PATTERNS.some((p) => p.test(prompt))) return "fix";
  if (REFACTOR_PATTERNS.some((p) => p.test(prompt))) return "refactor";
  if (DELETE_PATTERNS.some((p) => p.test(prompt))) return "delete";
  if (ADD_PATTERNS.some((p) => p.test(prompt))) return "add";
  if (MODIFY_PATTERNS.some((p) => p.test(prompt))) return "modify";

  return "other";
}

/**
 * Computes durability profiles from ledger entries.
 *
 * Groups entries by (actionType, targetRisk, scope), computes per-bucket
 * durability as survived/total, and attaches recommendations for low-durability buckets.
 */
export function computePromptDurabilityProfiles(
  ledgerEntries: LedgerEntryLike[]
): PromptDurabilityProfile[] {
  const buckets = new Map<
    string,
    { survived: number; total: number; key: BucketKey }
  >();

  for (const entry of ledgerEntries) {
    const actionType = extractActionType(entry.prompt ?? "");
    const targetRisk = normalizeRisk(entry.riskLevel);
    const scope = classifyScope(entry.files);

    const bucketId = `${actionType}:${targetRisk}:${scope}`;
    const existing = buckets.get(bucketId) ?? {
      survived: 0,
      total: 0,
      key: { actionType, targetRisk, scope },
    };

    existing.total += 1;
    if (entry.survived) {
      existing.survived += 1;
    }

    buckets.set(bucketId, existing);
  }

  const profiles: PromptDurabilityProfile[] = [];

  for (const bucket of buckets.values()) {
    const durability = bucket.total > 0 ? bucket.survived / bucket.total : 0;

    const profile: PromptDurabilityProfile = {
      actionType: bucket.key.actionType,
      targetRisk: bucket.key.targetRisk,
      scope: bucket.key.scope,
      durability: Math.round(durability * 1000) / 1000,
      sampleCount: bucket.total,
    };

    const recommendation = generateRecommendation(profile);
    if (recommendation) {
      profile.recommendation = recommendation;
    }

    profiles.push(profile);
  }

  profiles.sort((a, b) => {
    if (a.durability !== b.durability) return a.durability - b.durability;
    return b.sampleCount - a.sampleCount;
  });

  return profiles;
}

/**
 * Returns the overall durability across all profiles, weighted by sample count.
 */
export function computeOverallDurability(
  profiles: PromptDurabilityProfile[]
): number {
  let totalWeighted = 0;
  let totalSamples = 0;

  for (const p of profiles) {
    totalWeighted += p.durability * p.sampleCount;
    totalSamples += p.sampleCount;
  }

  return totalSamples > 0
    ? Math.round((totalWeighted / totalSamples) * 1000) / 1000
    : 0;
}

/**
 * Returns the top N most fragile profiles (lowest durability with sufficient samples).
 */
export function getMostFragile(
  profiles: PromptDurabilityProfile[],
  limit = 5,
  minSamples = 3
): PromptDurabilityProfile[] {
  return profiles
    .filter((p) => p.sampleCount >= minSamples)
    .sort((a, b) => a.durability - b.durability)
    .slice(0, limit);
}

/**
 * Returns the top N most durable profiles.
 */
export function getMostDurable(
  profiles: PromptDurabilityProfile[],
  limit = 5,
  minSamples = 3
): PromptDurabilityProfile[] {
  return profiles
    .filter((p) => p.sampleCount >= minSamples)
    .sort((a, b) => b.durability - a.durability)
    .slice(0, limit);
}

// ── Internal helpers ────────────────────────────────────────────────

interface BucketKey {
  actionType: PromptDurabilityProfile["actionType"];
  targetRisk: PromptDurabilityProfile["targetRisk"];
  scope: PromptDurabilityProfile["scope"];
}

function normalizeRisk(
  risk: string | undefined
): PromptDurabilityProfile["targetRisk"] {
  if (!risk) return "low";
  const lower = risk.toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  return "low";
}

function classifyScope(
  files: string[] | undefined
): PromptDurabilityProfile["scope"] {
  if (!files || files.length <= 1) return "single_file";
  return "multi_file";
}

function generateRecommendation(
  profile: PromptDurabilityProfile
): string | undefined {
  if (profile.sampleCount < 3) return undefined;

  if (profile.durability < 0.3) {
    if (profile.targetRisk === "critical" && profile.scope === "multi_file") {
      return "Multi-file changes to critical entities have very low durability. Break into smaller, single-file changes with tests between each.";
    }
    if (
      profile.actionType === "refactor" &&
      profile.targetRisk === "critical"
    ) {
      return "Refactoring critical entities is high-risk. Consider adding tests first, then refactoring in small verified steps.";
    }
    if (profile.actionType === "modify" && profile.scope === "multi_file") {
      return "Multi-file modifications have low survival. Consider narrowing scope or creating a working snapshot before proceeding.";
    }
    return `${profile.actionType} actions on ${profile.targetRisk}-risk entities have low durability (${Math.round(profile.durability * 100)}%). Consider smaller increments with verification.`;
  }

  if (profile.durability < 0.5) {
    if (profile.actionType === "fix") {
      return "Fix attempts have moderate durability. Ensure root cause analysis before applying fixes.";
    }
    return `${profile.actionType} actions show moderate durability. Consider verifying with tests after each change.`;
  }

  if (profile.durability >= 0.9 && profile.sampleCount >= 5) {
    return `${profile.actionType} actions on ${profile.targetRisk}-risk entities are highly durable — this is a strong pattern.`;
  }

  return undefined;
}
