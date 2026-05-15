/**
 * Cascade Consistency Guard — BA-1.3
 *
 * PostToolUse: when an agent modifies a function signature or type definition,
 * detects the change via AST diff, queries the blast radius graph for all
 * dependents, and injects an update checklist.
 *
 * Tracks which callers have been updated during the session so it can
 * hand off incomplete items to the Incomplete Work detector (BA-2.1).
 *
 * Performance: CozoDB blast radius query must resolve in <5ms.
 */

import type {
  CozoGraphStore,
  LocalEntity,
} from "../intelligence/local-graph.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";

export interface CallerAtRisk {
  file: string;
  entity: string;
  line: number;
  isTest: boolean;
}

export interface CascadeWarning {
  changed_entity: string;
  change_type: SignatureChangeType;
  blast_radius: {
    direct_callers: CallerAtRisk[];
    test_files: CallerAtRisk[];
    indirect_callers: number;
    total_at_risk: number;
  };
  suggestion: string;
}

export type SignatureChangeType =
  | "parameter_added"
  | "parameter_removed"
  | "parameter_renamed"
  | "return_type_changed"
  | "type_changed"
  | "signature_modified";

interface TrackedSignatureChange {
  entityKey: string;
  changeType: SignatureChangeType;
  callersAtRisk: CallerAtRisk[];
  callersUpdated: Set<string>;
  timestamp: number;
}

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test\//,
  /tests\//,
];

const EDIT_TOOLS = new Set([
  "file_write",
  "write_file",
  "edit_file",
  "str_replace_editor",
  "insert_code",
  "replace_code",
]);

export interface CascadeGuardConfig {
  enabled: boolean;
  level: AssertLevel;
  minCallersToWarn: number;
  includeTests: boolean;
}

export class CascadeConsistencyGuard extends Behavior {
  readonly id = "cascade_guard";
  readonly hooks = ["post_tool_use"] as const;
  readonly defaultLevel: AssertLevel = "suggestion";

  private graph: CozoGraphStore | null = null;
  private trackedChanges = new Map<string, TrackedSignatureChange>();
  private cascadeConfig: CascadeGuardConfig;

  constructor(config?: Partial<CascadeGuardConfig>) {
    super(config, "suggestion");
    this.cascadeConfig = {
      enabled: true,
      level: "suggestion",
      minCallersToWarn: 2,
      includeTests: true,
      ...config,
    };
  }

  attachGraph(graph: CozoGraphStore): void {
    this.graph = graph;
  }

  async onPostToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    if (!this.graph) return null;
    if (!isEditTool(ctx.toolName)) return null;

    const filePath = extractFilePath(ctx.args);
    if (!filePath) return null;

    const entities = await this.graph.getEntitiesByFile(filePath);
    if (entities.length === 0) return null;

    const oldContent = extractOldContent(ctx.args);
    const newContent = extractNewContent(ctx.args);
    if (!oldContent && !newContent) return null;

    const warnings: CascadeWarning[] = [];

    for (const entity of entities) {
      this.markCallerUpdated(entity.key, filePath);

      const changeType = detectSignatureChange(entity, oldContent, newContent);
      if (!changeType) continue;

      const callers = await this.graph.getCallersOf(entity.key);
      if (callers.length < this.cascadeConfig.minCallersToWarn) continue;

      const callersAtRisk = callers.map((c) => toCallerAtRisk(c));
      const directCallers = callersAtRisk.filter((c) => !c.isTest);
      const testCallers = callersAtRisk.filter((c) => c.isTest);

      const totalAtRisk = this.cascadeConfig.includeTests
        ? callersAtRisk.length
        : directCallers.length;

      if (totalAtRisk < this.cascadeConfig.minCallersToWarn) continue;

      this.trackedChanges.set(entity.key, {
        entityKey: entity.key,
        changeType,
        callersAtRisk,
        callersUpdated: new Set(),
        timestamp: Date.now(),
      });

      warnings.push({
        changed_entity: entity.signature || entity.name,
        change_type: changeType,
        blast_radius: {
          direct_callers: directCallers,
          test_files: testCallers,
          indirect_callers: 0,
          total_at_risk: totalAtRisk,
        },
        suggestion: buildSuggestion(entity.name, directCallers, testCallers),
      });
    }

    if (warnings.length === 0) return null;

    const totalCallersAtRisk = warnings.reduce(
      (sum, w) => sum + w.blast_radius.total_at_risk,
      0
    );

    return {
      behaviorId: this.id,
      level: this.level,
      relatedSkillId: "blast-radius-first",
      _meta: {
        behavior: this.id,
        callers_at_risk: totalCallersAtRisk,
        entities_changed: warnings.length,
      },
      _context: {
        cascade_warnings: warnings,
      },
    };
  }

  /**
   * Get all signature changes where not all callers have been updated.
   * Used by Incomplete Work Detection (BA-2.1).
   */
  getIncompleteChanges(): TrackedSignatureChange[] {
    const incomplete: TrackedSignatureChange[] = [];
    for (const change of this.trackedChanges.values()) {
      const remaining = change.callersAtRisk.filter(
        (c) => !change.callersUpdated.has(c.entity)
      );
      if (remaining.length > 0) incomplete.push(change);
    }
    return incomplete;
  }

  getSessionStats(): {
    signatureChangesDetected: number;
    totalCallersNotified: number;
    incompleteUpdates: number;
  } {
    let totalCallers = 0;
    let incompleteCount = 0;
    for (const change of this.trackedChanges.values()) {
      totalCallers += change.callersAtRisk.length;
      const remaining = change.callersAtRisk.filter(
        (c) => !change.callersUpdated.has(c.entity)
      );
      if (remaining.length > 0) incompleteCount++;
    }
    return {
      signatureChangesDetected: this.trackedChanges.size,
      totalCallersNotified: totalCallers,
      incompleteUpdates: incompleteCount,
    };
  }

  private markCallerUpdated(entityKey: string, filePath: string): void {
    for (const change of this.trackedChanges.values()) {
      for (const caller of change.callersAtRisk) {
        if (caller.file === filePath || caller.entity === entityKey) {
          change.callersUpdated.add(caller.entity);
        }
      }
    }
  }
}

function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function extractFilePath(args: Record<string, unknown>): string | null {
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.file === "string") return args.file;
  return null;
}

function extractOldContent(args: Record<string, unknown>): string | null {
  if (typeof args.old_str === "string") return args.old_str;
  if (typeof args.old_string === "string") return args.old_string;
  if (typeof args.before === "string") return args.before;
  return null;
}

function extractNewContent(args: Record<string, unknown>): string | null {
  if (typeof args.new_str === "string") return args.new_str;
  if (typeof args.new_string === "string") return args.new_string;
  if (typeof args.after === "string") return args.after;
  if (typeof args.content === "string") return args.content;
  return null;
}

/**
 * Lightweight signature change detection without full AST parsing.
 * Looks for function/method definition patterns that differ between
 * old and new content.
 */
function detectSignatureChange(
  entity: LocalEntity,
  oldContent: string | null,
  newContent: string | null
): SignatureChangeType | null {
  if (!oldContent || !newContent) {
    if (newContent && entity.signature) {
      const fnPattern = new RegExp(
        `(?:function|async\\s+function|export\\s+(?:async\\s+)?function)\\s+${escapeRegex(entity.name)}\\s*\\(`
      );
      if (fnPattern.test(newContent)) {
        return "signature_modified";
      }
    }
    return null;
  }

  const oldSigs = extractSignatures(oldContent, entity.name);
  const newSigs = extractSignatures(newContent, entity.name);

  if (oldSigs.length === 0 || newSigs.length === 0) return null;

  const oldSig = oldSigs[0]!;
  const newSig = newSigs[0]!;

  if (oldSig === newSig) return null;

  const oldParams = extractParams(oldSig);
  const newParams = extractParams(newSig);

  if (newParams.length > oldParams.length) return "parameter_added";
  if (newParams.length < oldParams.length) return "parameter_removed";

  const oldParamNames = oldParams.map((p) => p.split(/[:\s=]/)[0]?.trim());
  const newParamNames = newParams.map((p) => p.split(/[:\s=]/)[0]?.trim());
  for (let i = 0; i < oldParamNames.length; i++) {
    if (oldParamNames[i] !== newParamNames[i]) return "parameter_renamed";
  }

  const oldReturn = extractReturnType(oldSig);
  const newReturn = extractReturnType(newSig);
  if (oldReturn !== newReturn && oldReturn && newReturn)
    return "return_type_changed";

  return "type_changed";
}

function extractSignatures(content: string, entityName: string): string[] {
  const escapedName = escapeRegex(entityName);
  const patterns = [
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`,
      "g"
    ),
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?${escapedName}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`,
      "g"
    ),
  ];

  const results: string[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    match = pattern.exec(content);
    while (match !== null) {
      results.push(match[0]);
      match = pattern.exec(content);
    }
    if (results.length > 0) break;
  }
  return results;
}

function extractParams(signature: string): string[] {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match || !match[1]?.trim()) return [];
  return match[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractReturnType(signature: string): string | null {
  const afterParen = signature.split(")").slice(1).join(")").trim();
  if (!afterParen.startsWith(":")) return null;
  return afterParen.slice(1).trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toCallerAtRisk(entity: LocalEntity): CallerAtRisk {
  return {
    file: entity.file_path,
    entity: entity.name,
    line: entity.start_line,
    isTest: isTestFilePath(entity.file_path),
  };
}

function buildSuggestion(
  entityName: string,
  direct: CallerAtRisk[],
  tests: CallerAtRisk[]
): string {
  const total = direct.length + tests.length;
  const parts = [`Update all ${total} caller(s) of ${entityName}.`];
  if (direct.length > 0) {
    parts.push(
      `Start with ${direct.length} direct caller(s): ${direct
        .map((c) => `${c.file.split("/").pop()}:${c.entity}`)
        .slice(0, 3)
        .join(
          ", "
        )}${direct.length > 3 ? ` (+${direct.length - 3} more)` : ""}.`
    );
  }
  if (tests.length > 0) {
    parts.push(`Then update ${tests.length} test file(s).`);
  }
  return parts.join(" ");
}
