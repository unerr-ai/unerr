/**
 * Sprint L6.2: Local Rule Generator from Conventions
 *
 * Converts detected convention patterns into evaluable rules compatible
 * with the CozoDB `rules` relation and `rule-evaluator.ts`.
 *
 * Each generated rule uses `engine: "structural"` (tree-sitter / naming regex),
 * NEVER LLM-based evaluation. Rules carry `source: "local-convention-detector"`
 * attribution to distinguish from external rules.
 *
 * All logging to stderr. Never touches stdout.
 */

import type { DetectedConvention } from "./local-convention-detector.js";
import type { CompactRule } from "./local-graph.js";

// ── Types ────────────────────────────────────────────────────────

export interface RuleGenerationResult {
  rules: CompactRule[];
  stats: {
    naming: number;
    structural: number;
    importDirection: number;
    total: number;
  };
}

// ── Naming → Query Mapping ──────────────────────────────────────

/** Maps naming pattern IDs to tree-sitter query fragments for rule-evaluator.ts. */
const NAMING_QUERIES: Record<string, string> = {
  camelCase: "^[a-z][a-zA-Z0-9]*$",
  PascalCase: "^[A-Z][a-zA-Z0-9]*$",
  snake_case: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
  SCREAMING_SNAKE: "^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$",
  "kebab-case": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
};

/** Maps entity kinds to glob patterns. */
const KIND_TO_GLOB: Record<string, string> = {
  function: "**/*.{ts,tsx,js,jsx,py,go}",
  class: "**/*.{ts,tsx,js,jsx,py,java}",
  interface: "**/*.{ts,tsx}",
  type: "**/*.{ts,tsx}",
  method: "**/*.{ts,tsx,js,jsx,py,go,java}",
  variable: "**/*.{ts,tsx,js,jsx}",
  component: "**/*.{tsx,jsx}",
};

// ── Main Generation Function ────────────────────────────────────

/**
 * Generate evaluable rules from detected convention patterns.
 *
 * @param conventions - Output from detectLocalConventions()
 * @param repoId - Repository ID for rule scoping
 * @returns CompactRule[] ready for CozoGraphStore.loadRules()
 */
export function generateLocalRules(
  conventions: DetectedConvention[],
  repoId: string,
): RuleGenerationResult {
  const rules: CompactRule[] = [];
  let naming = 0;
  let structural = 0;
  let importDirection = 0;

  for (const convention of conventions) {
    const rule = conventionToRule(convention, repoId);
    if (rule) {
      rules.push(rule);
      switch (convention.kind) {
        case "naming":
          naming++;
          break;
        case "structure":
          structural++;
          break;
        case "import_direction":
          importDirection++;
          break;
      }
    }
  }

  return {
    rules,
    stats: {
      naming,
      structural,
      importDirection,
      total: rules.length,
    },
  };
}

// ── Convention → Rule Conversion ────────────────────────────────

function conventionToRule(
  convention: DetectedConvention,
  repoId: string,
): CompactRule | null {
  const ruleKey = `local-rule-${convention.key}`;

  switch (convention.kind) {
    case "naming":
      return namingConventionToRule(convention, ruleKey, repoId);
    case "structure":
      return structureConventionToRule(convention, ruleKey, repoId);
    case "import_direction":
      return importDirectionConventionToRule(convention, ruleKey, repoId);
    default:
      return null;
  }
}

function namingConventionToRule(
  convention: DetectedConvention,
  ruleKey: string,
  repoId: string,
): CompactRule {
  // Extract naming pattern ID from convention key (e.g., "naming-function-camelCase" → "camelCase")
  const parts = convention.key.split("-");
  const patternId = parts[parts.length - 1] as string;
  const entityKind = parts.slice(1, -1).join("-");
  const query = NAMING_QUERIES[patternId] ?? "";
  const glob = KIND_TO_GLOB[entityKind] ?? "**/*.{ts,tsx,js,jsx}";

  return {
    key: ruleKey,
    name: convention.name,
    scope: "repo",
    severity: "warn",
    engine: "structural",
    query,
    message: `Convention: ${convention.name} (${Math.round(convention.confidence * 100)}% adherence). ${convention.detail}`,
    file_glob: glob,
    enabled: true,
    repo_id: repoId,
    status: "active",
    target_kinds: entityKind === "component" ? "function" : entityKind,
    ast_grep_fix: "",
    example: "",
    decay_score: 0,
    evaluations: 0,
    overrides: 0,
  };
}

function structureConventionToRule(
  convention: DetectedConvention,
  ruleKey: string,
  repoId: string,
): CompactRule {
  return {
    key: ruleKey,
    name: convention.name,
    scope: "repo",
    severity: "info",
    engine: "structural",
    query: "",
    message: `Structure convention: ${convention.detail}`,
    file_glob: "**/*.{ts,tsx,js,jsx}",
    enabled: true,
    repo_id: repoId,
    status: "active",
    target_kinds: "",
    ast_grep_fix: "",
    example: "",
    decay_score: 0,
    evaluations: 0,
    overrides: 0,
  };
}

function importDirectionConventionToRule(
  convention: DetectedConvention,
  ruleKey: string,
  repoId: string,
): CompactRule {
  return {
    key: ruleKey,
    name: convention.name,
    scope: "repo",
    severity: "warn",
    engine: "structural",
    query: "",
    message: `Import direction convention: ${convention.detail}`,
    file_glob: "**/*.{ts,tsx,js,jsx}",
    enabled: true,
    repo_id: repoId,
    status: "active",
    target_kinds: "",
    ast_grep_fix: "",
    example: "",
    decay_score: 0,
    evaluations: 0,
    overrides: 0,
  };
}
