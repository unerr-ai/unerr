/**
 * Phase 10b + Sprint 9: Local rule evaluator — tree-sitter structural + naming evaluation.
 *
 * Evaluates rules locally.
 * - Structural rules: Uses tree-sitter to parse AST and match node types
 * - Naming rules: Uses regex against entity names from CozoDB
 * - Semgrep/LLM rules: Skipped (not yet supported locally)
 *
 * Sprint 9 additions:
 * - 9.1: JIT Rule Filtering — score rules by relevance, cap at 30
 * - 9.2: Auto-Remediation Passthrough — ast_grep_fix → autoFix in violations
 * - 9.5: STAGED Rule Dry-Run — evaluate but separate into stagedRuleResults
 * - 9.6: Rule Exception TTL — active exceptions downgrade to "suggest"
 */

import type {
  CompactRule,
  CompactRuleException,
  CozoGraphStore,
} from "./local-graph.js";

export interface RuleViolation {
  ruleKey: string;
  ruleName: string;
  severity: string;
  message: string;
  filePath: string;
  line?: number;
  matchedCode?: string;
  /** Sprint 9.2: Auto-fix from ast-grep fix directive */
  autoFix?: {
    rule: string;
    diff: string;
    confidence: number;
  };
  /** Sprint 9.6: Exception that downgrades this violation */
  exception?: {
    key: string;
    reason: string;
    expires_at: string;
    granted_by: string;
  };
}

/** Sprint 9.5: Staged rule result (evaluated but not enforced) */
export interface StagedRuleResult {
  ruleKey: string;
  ruleName: string;
  wouldViolate: boolean;
  violationCount: number;
  message: string;
}

export interface EvaluationResult {
  violations: RuleViolation[];
  _meta: {
    source: "local";
    evaluatedRules: number;
    skippedRules: number;
    engines: { structural: number; naming: number; skipped: number };
    /** Sprint 9.1: JIT filtering stats */
    jitFiltering?: {
      totalRules: number;
      relevantRules: number;
      maxScore: number;
    };
    /** Sprint 9.5: Staged rule dry-run results */
    stagedRuleResults?: StagedRuleResult[];
    /** Sprint 9.6: Exceptions that modified enforcement */
    exceptionsApplied?: number;
    /** Sprint 9.6: Exceptions expiring within 7 days */
    expiringExceptions?: Array<{
      ruleKey: string;
      entityKey: string;
      expires_at: string;
      jira_ticket: string;
    }>;
  };
}

/** Sprint 9.1: Rule with computed relevance score */
interface ScoredRule extends CompactRule {
  relevanceScore: number;
}

type TreeSitterParser = {
  parse(input: string): { rootNode: TreeSitterNode };
};

type TreeSitterNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
};

// Lazy-loaded tree-sitter instance
let parserCache: Map<string, TreeSitterParser> | null = null;

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".py": "python",
  ".go": "go",
};

/**
 * Detect language from file extension.
 */
function detectLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return LANGUAGE_MAP[ext] ?? null;
}

/**
 * Lazy-load tree-sitter parser for a language.
 * Returns null if the language is not supported or tree-sitter is not available.
 */
async function getParser(language: string): Promise<TreeSitterParser | null> {
  if (!parserCache) {
    parserCache = new Map();
  }

  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  try {
    const TreeSitter = (await import("web-tree-sitter")).default;
    await TreeSitter.init();
    const parser = new TreeSitter();

    // Try to load language grammar from node_modules
    const langFile = `tree-sitter-${language}.wasm`;
    try {
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");

      // Check multiple possible locations for WASM files
      const possiblePaths = [
        join(
          process.cwd(),
          "node_modules",
          `tree-sitter-${language}`,
          langFile
        ),
        join(process.cwd(), "node_modules", "web-tree-sitter", langFile),
      ];

      let wasmPath: string | null = null;
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          wasmPath = p;
          break;
        }
      }

      if (!wasmPath) {
        // Grammar WASM not found — degrade gracefully
        return null;
      }

      const lang = await TreeSitter.Language.load(wasmPath);
      parser.setLanguage(lang);
      parserCache.set(language, parser as unknown as TreeSitterParser);
      return parser as unknown as TreeSitterParser;
    } catch {
      return null;
    }
  } catch {
    // web-tree-sitter not available
    return null;
  }
}

/**
 * Walk tree-sitter AST and collect nodes matching target types.
 */
function collectNodesByType(
  node: TreeSitterNode,
  targetTypes: string[]
): TreeSitterNode[] {
  const results: TreeSitterNode[] = [];

  function walk(n: TreeSitterNode): void {
    if (targetTypes.includes(n.type)) {
      results.push(n);
    }
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return results;
}

/**
 * Evaluate a structural rule using tree-sitter AST matching.
 */
async function evaluateStructural(
  rule: CompactRule,
  filePath: string,
  content: string
): Promise<RuleViolation[]> {
  const language = detectLanguage(filePath);
  if (!language) return [];

  const parser = await getParser(language);
  if (!parser) return [];

  const tree = parser.parse(content);

  // Parse rule.query as comma-separated node types to match
  const targetTypes = rule.query
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (targetTypes.length === 0) return [];

  const matches = collectNodesByType(tree.rootNode, targetTypes);

  return matches.map((node) => ({
    ruleKey: rule.key,
    ruleName: rule.name,
    severity: rule.severity,
    message:
      rule.message ||
      `Structural rule "${rule.name}" matched node type "${node.type}"`,
    filePath,
    line: node.startPosition.row + 1,
    matchedCode: node.text.slice(0, 200),
  }));
}

/**
 * Evaluate a naming rule using regex against entity names in the file.
 */
async function evaluateNaming(
  rule: CompactRule,
  filePath: string,
  localGraph: CozoGraphStore
): Promise<RuleViolation[]> {
  const entities = await localGraph.getEntitiesByFile(filePath);
  if (entities.length === 0) return [];

  let regex: RegExp;
  try {
    regex = new RegExp(rule.query);
  } catch {
    return [];
  }

  const violations: RuleViolation[] = [];

  for (const entity of entities) {
    if (regex.test(entity.name)) {
      violations.push({
        ruleKey: rule.key,
        ruleName: rule.name,
        severity: rule.severity,
        message:
          rule.message ||
          `Naming rule "${rule.name}" matched entity "${entity.name}"`,
        filePath,
        line: entity.start_line,
        matchedCode: entity.name,
      });
    }
  }

  return violations;
}

/**
 * Sprint 9.1: JIT Rule Filtering — score rules by relevance to target entity context.
 *
 * Scoring (Phase 6 §1.4b):
 *   +0.4 if rule.file_glob matches filePath
 *   +0.2 if rule.scope == "repo"
 *   +0.3 if entity kind ∈ rule.target_kinds
 *   +0.1 if rule.severity == "block" (always included)
 *
 * Returns rules with score > 0.3 OR severity == "block", capped at 30.
 */
export async function getRelevantRules(
  allRules: CompactRule[],
  filePath: string,
  entityKey: string | undefined,
  localGraph: CozoGraphStore
): Promise<{ rules: ScoredRule[]; totalRules: number; maxScore: number }> {
  const entityMeta = entityKey ? await localGraph.getEntity(entityKey) : null;

  const scored: ScoredRule[] = allRules.map((rule) => {
    let score = 0.0;

    // +0.4 for file_glob match
    if (rule.file_glob && matchesGlob(filePath, rule.file_glob)) {
      score += 0.4;
    } else if (!rule.file_glob) {
      // No glob means rule applies to all files — partial credit
      score += 0.2;
    }

    // +0.2 for repo scope
    if (rule.scope === "repo") {
      score += 0.2;
    }

    // +0.3 for entity kind match
    if (entityMeta && rule.target_kinds) {
      const targetKinds = rule.target_kinds.split(",").map((k) => k.trim());
      if (targetKinds.includes(entityMeta.kind)) {
        score += 0.3;
      }
    }

    // +0.1 for block severity (ensures inclusion)
    if (rule.severity === "block") {
      score += 0.1;
    }

    return { ...rule, relevanceScore: score };
  });

  // Filter: score > 0.3 OR severity == "block"
  const relevant = scored
    .filter((r) => r.relevanceScore > 0.3 || r.severity === "block")
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 30);

  const maxScore =
    relevant.length > 0 ? (relevant[0]?.relevanceScore as number) : 0;

  return { rules: relevant, totalRules: allRules.length, maxScore };
}

/**
 * Simple glob matching for file paths.
 */
function matchesGlob(filePath: string, glob: string): boolean {
  // Convert glob to regex: * → [^/]*, ** → .*, ? → .
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`).test(filePath);
  } catch {
    return false;
  }
}

/**
 * Evaluate all applicable rules against a file.
 *
 * Sprint 9 enhancements:
 * - 9.1: JIT filtering (when entityKey provided)
 * - 9.2: Auto-remediation passthrough (ast_grep_fix → autoFix)
 * - 9.5: STAGED rules evaluated but separated into the evaluator's internal `_meta.stagedRuleResults` return field (not the wire envelope)
 * - 9.6: Rule exceptions downgrade enforcement to "suggest"
 *
 * Partitions rules by engine:
 * - structural: tree-sitter AST matching
 * - naming: regex match against entity names
 * - semgrep/llm: skipped (not supported locally)
 */
export async function evaluateRules(
  rules: CompactRule[],
  filePath: string,
  content: string,
  localGraph: CozoGraphStore,
  options?: {
    /** Sprint 9.1: Entity key for JIT filtering */
    entityKey?: string;
    /** Sprint 9.6: Pre-fetched exceptions for entities in this file */
    exceptions?: CompactRuleException[];
  }
): Promise<EvaluationResult> {
  const violations: RuleViolation[] = [];
  const stagedResults: StagedRuleResult[] = [];
  let structuralCount = 0;
  let namingCount = 0;
  let skippedCount = 0;
  let exceptionsApplied = 0;

  // Sprint 9.1: JIT filtering
  let jitMeta: EvaluationResult["_meta"]["jitFiltering"];
  let activeRules: CompactRule[];

  if (options?.entityKey) {
    const jit = await getRelevantRules(
      rules,
      filePath,
      options.entityKey,
      localGraph
    );
    activeRules = jit.rules;
    jitMeta = {
      totalRules: jit.totalRules,
      relevantRules: jit.rules.length,
      maxScore: jit.maxScore,
    };
  } else {
    activeRules = rules;
  }

  // Sprint 9.5: Separate staged rules
  const enforceableRules: CompactRule[] = [];
  const stagedRules: CompactRule[] = [];

  for (const rule of activeRules) {
    if ((rule.status ?? "active") === "staged") {
      stagedRules.push(rule);
    } else {
      enforceableRules.push(rule);
    }
  }

  // Build exception lookup: ruleKey → exception[]
  const exceptionMap = new Map<string, CompactRuleException[]>();
  if (options?.exceptions) {
    for (const ex of options.exceptions) {
      const existing = exceptionMap.get(ex.rule_key) ?? [];
      existing.push(ex);
      exceptionMap.set(ex.rule_key, existing);
    }
  }

  // Evaluate enforceable rules
  for (const rule of enforceableRules) {
    if (!rule.enabled) {
      skippedCount++;
      continue;
    }

    const ruleViolations = await evaluateSingleRule(
      rule,
      filePath,
      content,
      localGraph
    );

    if (ruleViolations.engine === "skipped") {
      skippedCount++;
      continue;
    }

    if (ruleViolations.engine === "structural") structuralCount++;
    else if (ruleViolations.engine === "naming") namingCount++;

    // Sprint 9.6: Check exceptions for each violation
    for (const v of ruleViolations.violations) {
      const ruleExceptions = exceptionMap.get(rule.key);
      if (ruleExceptions && ruleExceptions.length > 0) {
        const activeEx = ruleExceptions[0] as (typeof ruleExceptions)[number];
        v.severity = "suggest";
        v.exception = {
          key: activeEx.key,
          reason: activeEx.reason,
          expires_at: activeEx.expires_at,
          granted_by: activeEx.granted_by,
        };
        exceptionsApplied++;
      }

      // Sprint 9.2: Auto-remediation passthrough
      if (rule.ast_grep_fix) {
        v.autoFix = {
          rule: rule.key,
          diff: rule.ast_grep_fix,
          confidence: 0.95,
        };
      }

      violations.push(v);
    }
  }

  // Sprint 9.5: Evaluate staged rules (dry-run only)
  for (const rule of stagedRules) {
    if (!rule.enabled) continue;

    const ruleViolations = await evaluateSingleRule(
      rule,
      filePath,
      content,
      localGraph
    );

    if (ruleViolations.engine === "skipped") continue;

    stagedResults.push({
      ruleKey: rule.key,
      ruleName: rule.name,
      wouldViolate: ruleViolations.violations.length > 0,
      violationCount: ruleViolations.violations.length,
      message:
        ruleViolations.violations.length > 0
          ? (ruleViolations.violations[0]?.message as string)
          : `No violations for staged rule "${rule.name}"`,
    });
  }

  // Sprint 9.6: Check for expiring exceptions (7 day window)
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const expiringExceptions = (
    await localGraph.getExpiringExceptions(SEVEN_DAYS_MS)
  ).map(
    (ex: {
      rule_key: string;
      entity_key: string;
      expires_at: string;
      jira_ticket: string;
    }) => ({
      ruleKey: ex.rule_key,
      entityKey: ex.entity_key,
      expires_at: ex.expires_at,
      jira_ticket: ex.jira_ticket,
    })
  );

  return {
    violations,
    _meta: {
      source: "local",
      evaluatedRules: structuralCount + namingCount,
      skippedRules: skippedCount,
      engines: {
        structural: structuralCount,
        naming: namingCount,
        skipped: skippedCount,
      },
      ...(jitMeta ? { jitFiltering: jitMeta } : {}),
      ...(stagedResults.length > 0 ? { stagedRuleResults: stagedResults } : {}),
      ...(exceptionsApplied > 0 ? { exceptionsApplied } : {}),
      ...(expiringExceptions.length > 0 ? { expiringExceptions } : {}),
    },
  };
}

/**
 * Evaluate a single rule and return violations + engine type.
 */
async function evaluateSingleRule(
  rule: CompactRule,
  filePath: string,
  content: string,
  localGraph: CozoGraphStore
): Promise<{ violations: RuleViolation[]; engine: string }> {
  switch (rule.engine) {
    case "structural": {
      const violations = await evaluateStructural(rule, filePath, content);
      return { violations, engine: "structural" };
    }
    case "naming": {
      const violations = await evaluateNaming(rule, filePath, localGraph);
      return { violations, engine: "naming" };
    }
    default:
      return { violations: [], engine: "skipped" };
  }
}
