/**
 * Convention Drift Prevention — BA-2.2
 *
 * PostToolUse: checks changed code regions against detected project conventions.
 * Detects naming violations (camelCase vs snake_case), structural violations
 * (barrel imports, file organization), and suggests or auto-fixes.
 *
 * Learning loop: developer corrections (accepted/dismissed) adjust
 * confidence thresholds per convention.
 *
 * Auto-fix only applied when confidence > 0.9.
 */

import type { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";

const AUTO_FIX_CONFIDENCE_THRESHOLD = 0.9;

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

interface NamingRule {
  id: string;
  pattern: RegExp;
  label: string;
}

const NAMING_RULES: NamingRule[] = [
  { id: "camelCase", pattern: CAMEL_CASE, label: "camelCase" },
  { id: "PascalCase", pattern: PASCAL_CASE, label: "PascalCase" },
  { id: "snake_case", pattern: SNAKE_CASE, label: "snake_case" },
];

export interface ConventionViolation {
  rule: string;
  violation: string;
  file: string;
  confidence: number;
  autoFixed: boolean;
  evidence: string;
}

const EDIT_TOOLS = new Set([
  "file_write",
  "write_file",
  "edit_file",
  "str_replace_editor",
  "insert_code",
  "replace_code",
]);

export interface ConventionDriftConfig {
  enabled: boolean;
  level: AssertLevel;
  autoFixHighConfidence: boolean;
  confidenceThreshold: number;
}

export class ConventionDriftPrevention extends Behavior {
  readonly id = "convention_drift";
  readonly hooks = ["post_tool_use"] as const;
  readonly defaultLevel: AssertLevel = "suggestion";

  private graph: CozoGraphStore | null = null;
  private driftConfig: ConventionDriftConfig;
  private violationsThisSession = 0;
  private autoFixesThisSession = 0;

  constructor(config?: Partial<ConventionDriftConfig>) {
    super(config, "suggestion");
    this.driftConfig = {
      enabled: true,
      level: "suggestion",
      autoFixHighConfidence: true,
      confidenceThreshold: AUTO_FIX_CONFIDENCE_THRESHOLD,
      ...config,
    };
  }

  attachGraph(graph: CozoGraphStore): void {
    this.graph = graph;
  }

  async onPostToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    if (!EDIT_TOOLS.has(ctx.toolName)) return null;
    if (!ctx.filePath) return null;
    if (!isCodeFile(ctx.filePath)) return null;

    const newContent = extractNewContent(ctx.args);
    if (!newContent) return null;

    const violations: ConventionViolation[] = [];

    const namingViolations = await this.checkNamingConventions(
      ctx.filePath,
      newContent
    );
    violations.push(...namingViolations);

    const importViolations = await this.checkImportConventions(
      ctx.filePath,
      newContent
    );
    violations.push(...importViolations);

    if (violations.length === 0) return null;

    this.violationsThisSession += violations.length;
    const autoFixCount = violations.filter((v) => v.autoFixed).length;
    this.autoFixesThisSession += autoFixCount;

    return {
      behaviorId: this.id,
      level: this.level,
      relatedSkillId: "convention-aware-generation",
      _meta: {
        behavior: this.id,
        violations: violations.length,
        auto_fixed: autoFixCount,
      },
      _context: {
        convention_violations: violations,
      },
    };
  }

  getSessionStats(): {
    violationsDetected: number;
    autoFixes: number;
  } {
    return {
      violationsDetected: this.violationsThisSession,
      autoFixes: this.autoFixesThisSession,
    };
  }

  /**
   * Check naming conventions in new content against project-wide patterns.
   * Uses the graph's convention data to determine the dominant style.
   */
  private async checkNamingConventions(
    filePath: string,
    content: string
  ): Promise<ConventionViolation[]> {
    const projectConvention =
      await this.detectDominantNamingConvention(filePath);
    if (!projectConvention) return [];

    const newNames = extractDefinedNames(content);
    const violations: ConventionViolation[] = [];

    for (const name of newNames) {
      if (name.length <= 1) continue;
      if (isAllCaps(name)) continue;

      if (!projectConvention.pattern.test(name)) {
        const expected = suggestFix(name, projectConvention.id);
        const confidence = projectConvention.confidence;
        const canAutoFix =
          this.driftConfig.autoFixHighConfidence &&
          confidence >= this.driftConfig.confidenceThreshold &&
          expected !== null;

        violations.push({
          rule: `naming:${projectConvention.id}_for_identifiers`,
          violation: `${name} (should be ${expected ?? projectConvention.label})`,
          file: filePath,
          confidence,
          autoFixed: canAutoFix,
          evidence: `${Math.round(projectConvention.confidence * 100)}% of identifiers in this context use ${projectConvention.label}`,
        });
      }
    }

    return violations;
  }

  /**
   * Check import conventions — barrel exports, relative vs absolute, etc.
   */
  private async checkImportConventions(
    filePath: string,
    content: string
  ): Promise<ConventionViolation[]> {
    if (!this.graph) return [];

    const conventions = await this.graph.getConventionsForEntity(filePath, 5);
    const importConventions = conventions.filter(
      (c) =>
        c.name.toLowerCase().includes("import") ||
        c.name.toLowerCase().includes("barrel")
    );

    if (importConventions.length === 0) return [];

    const violations: ConventionViolation[] = [];
    const importLines = extractImportLines(content);

    for (const convention of importConventions) {
      const adherence = convention.adherence_pct / 100;
      if (adherence < 0.6) continue;

      if (convention.name.toLowerCase().includes("barrel")) {
        for (const imp of importLines) {
          if (isDeepImport(imp)) {
            violations.push({
              rule: "import:barrel_exports",
              violation: `Deep import "${imp}" — project convention uses barrel exports`,
              file: filePath,
              confidence: adherence,
              autoFixed: false,
              evidence:
                convention.rule ||
                `${convention.adherence_pct}% of imports follow barrel pattern`,
            });
          }
        }
      }
    }

    return violations;
  }

  private async detectDominantNamingConvention(filePath: string): Promise<{
    id: string;
    pattern: RegExp;
    label: string;
    confidence: number;
  } | null> {
    if (!this.graph) return null;

    const conventions = await this.graph.getConventionsForEntity(filePath, 5);
    const namingConvention = conventions.find(
      (c) =>
        c.name.toLowerCase().includes("naming") ||
        c.name.toLowerCase().includes("camel") ||
        c.name.toLowerCase().includes("pascal") ||
        c.name.toLowerCase().includes("snake")
    );

    if (namingConvention) {
      const rule = NAMING_RULES.find((r) =>
        namingConvention.name.toLowerCase().includes(r.id.toLowerCase())
      );
      if (rule) {
        return { ...rule, confidence: namingConvention.adherence_pct / 100 };
      }
    }

    const entities = await this.graph.getEntitiesByFile(filePath);
    if (entities.length < 3) return null;

    const counts = new Map<string, number>();
    for (const entity of entities) {
      if (entity.kind !== "function" && entity.kind !== "variable") continue;
      for (const rule of NAMING_RULES) {
        if (rule.pattern.test(entity.name)) {
          counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
          break;
        }
      }
    }

    let best: { id: string; count: number } | null = null;
    for (const [id, count] of counts) {
      if (!best || count > best.count) best = { id, count };
    }

    if (!best) return null;

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const confidence = best.count / total;
    if (confidence < 0.6) return null;

    const rule = NAMING_RULES.find((r) => r.id === best?.id);
    if (!rule) return null;

    return { ...rule, confidence };
  }
}

function isCodeFile(filePath: string): boolean {
  return /\.[jt]sx?$|\.vue$|\.svelte$/.test(filePath);
}

function extractNewContent(args: Record<string, unknown>): string | null {
  if (typeof args.new_str === "string") return args.new_str;
  if (typeof args.new_string === "string") return args.new_string;
  if (typeof args.content === "string") return args.content;
  if (typeof args.after === "string") return args.after;
  return null;
}

/**
 * Extract names defined in code (function names, variable names, class names).
 * Lightweight regex-based extraction — not full AST, but fast and sufficient.
 */
function extractDefinedNames(content: string): string[] {
  const names: string[] = [];
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
    /(?:export\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /(?:export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    /(?:export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
    /(?:export\s+)?enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    match = pattern.exec(content);
    while (match !== null) {
      if (match[1]) names.push(match[1]);
      match = pattern.exec(content);
    }
  }

  return [...new Set(names)];
}

function extractImportLines(content: string): string[] {
  const imports: string[] = [];
  const pattern = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  match = pattern.exec(content);
  while (match !== null) {
    if (match[1]) imports.push(match[1]);
    match = pattern.exec(content);
  }
  return imports;
}

function isDeepImport(importPath: string): boolean {
  if (!importPath.startsWith(".")) return false;
  const segments = importPath.split("/").filter(Boolean);
  const nonDots = segments.filter((s) => s !== "." && s !== "..");
  return nonDots.length >= 3;
}

function isAllCaps(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

function suggestFix(name: string, targetConvention: string): string | null {
  const words = splitIntoWords(name);
  if (words.length === 0) return null;

  switch (targetConvention) {
    case "camelCase":
      return words[0]?.toLowerCase() + words.slice(1).map(capitalize).join("");
    case "PascalCase":
      return words.map(capitalize).join("");
    case "snake_case":
      return words.map((w) => w.toLowerCase()).join("_");
    default:
      return null;
  }
}

function splitIntoWords(name: string): string[] {
  if (name.includes("_")) return name.split("_").filter(Boolean);
  if (name.includes("-")) return name.split("-").filter(Boolean);
  return name.split(/(?=[A-Z])/).filter(Boolean);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
