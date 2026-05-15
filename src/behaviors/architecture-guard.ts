/**
 * Architecture Boundary Guard — BA-3.1
 *
 * PreToolUse: when an agent writes/edits code, parses new import statements,
 * resolves them to file paths, and queries CozoDB for community membership.
 * Blocks cross-community direct imports unless:
 *   - The import is a type-only import (`import type`)
 *   - An override comment (`// @unerr-allow cross-community: [reason]`) exists
 *   - An established bridge exists (same pattern used 3+ times → auto-bridge)
 *
 * Assertiveness: enforcement (blocks with alternatives)
 * Performance: <5ms (CozoDB community query)
 */

import type { CozoGraphStore } from "../intelligence/local-graph.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";

const BRIDGE_THRESHOLD = 3;
const OVERRIDE_PATTERN = /\/\/\s*@unerr-allow\s+cross-community:\s*(.*)/;

const EDIT_TOOLS = new Set([
  "file_write",
  "write_file",
  "edit_file",
  "str_replace_editor",
  "insert_code",
  "replace_code",
]);

export interface BoundaryViolation {
  import: string;
  sourceFile: string;
  sourceCommunity: string;
  sourceCommunityId: number;
  targetCommunity: string;
  targetCommunityId: number;
  violationType: "cross_community_direct_import";
}

export interface AlternativePattern {
  pattern: string;
  example: string;
  precedent?: string;
}

interface BridgeRecord {
  sourceCommunity: number;
  targetCommunity: number;
  overrideCount: number;
  autoBridged: boolean;
}

export interface ArchitectureGuardConfig {
  enabled: boolean;
  level: AssertLevel;
  allowTypeImports: boolean;
  bridgeThreshold: number;
}

export class ArchitectureBoundaryGuard extends Behavior {
  readonly id = "architecture_boundary";
  readonly hooks = ["pre_tool_use"] as const;
  readonly defaultLevel: AssertLevel = "enforcement";

  private graph: CozoGraphStore | null = null;
  private bridges = new Map<string, BridgeRecord>();
  private guardConfig: ArchitectureGuardConfig;
  private violationsBlocked = 0;
  private typeImportsAllowed = 0;
  private overridesRecorded = 0;

  constructor(config?: Partial<ArchitectureGuardConfig>) {
    super(config, "enforcement");
    this.guardConfig = {
      enabled: true,
      level: "enforcement",
      allowTypeImports: true,
      bridgeThreshold: BRIDGE_THRESHOLD,
      ...config,
    };
  }

  attachGraph(graph: CozoGraphStore): void {
    this.graph = graph;
  }

  async onPreToolUse(ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    if (!this.graph) return null;
    if (!EDIT_TOOLS.has(ctx.toolName)) return null;

    const filePath = extractFilePath(ctx.args);
    if (!filePath) return null;
    if (!isCodeFile(filePath)) return null;

    const newContent = extractNewContent(ctx.args);
    if (!newContent) return null;

    const imports = parseImports(newContent);
    if (imports.length === 0) return null;

    const sourceEntities = await this.graph.getEntitiesByFile(filePath);
    if (sourceEntities.length === 0) return null;

    const sourceCommunity = await this.graph.getCommunityForEntity(
      sourceEntities[0]!.key
    );
    if (!sourceCommunity) return null;

    const violations: BoundaryViolation[] = [];
    const alternatives: AlternativePattern[] = [];

    for (const imp of imports) {
      if (imp.isTypeOnly && this.guardConfig.allowTypeImports) {
        this.typeImportsAllowed++;
        continue;
      }

      if (imp.hasOverride) {
        this.overridesRecorded++;
        await this.recordOverride(
          sourceCommunity.id,
          imp.resolvedPath ?? "",
          filePath
        );
        continue;
      }

      const targetCommunity = await this.resolveTargetCommunity(
        imp.resolvedPath ?? imp.specifier,
        filePath
      );
      if (!targetCommunity) continue;
      if (targetCommunity.id === sourceCommunity.id) continue;

      const bridgeKey = `${sourceCommunity.id}→${targetCommunity.id}`;
      const bridge = this.bridges.get(bridgeKey);
      if (bridge?.autoBridged) continue;

      violations.push({
        import: imp.raw,
        sourceFile: filePath,
        sourceCommunity: sourceCommunity.label,
        sourceCommunityId: sourceCommunity.id,
        targetCommunity: targetCommunity.label,
        targetCommunityId: targetCommunity.id,
        violationType: "cross_community_direct_import",
      });

      alternatives.push(
        {
          pattern: "type_import",
          example: `import type { ... } from '${imp.specifier}' // types are OK, not implementation`,
        },
        {
          pattern: "interface_bridge",
          example:
            "Define shared types in a schemas/ module accessible to both communities",
        }
      );
    }

    if (violations.length === 0) return null;

    this.violationsBlocked += violations.length;

    return {
      behaviorId: this.id,
      level: this.level,
      halt: this.level === "enforcement",
      relatedSkillId: "understand-before-modify",
      _meta: {
        behavior: this.id,
        blocked: this.level === "enforcement",
        violations_count: violations.length,
      },
      _context: {
        violations: violations.map((v) => ({
          import: v.import,
          source_file: v.sourceFile,
          source_community: v.sourceCommunity,
          target_community: v.targetCommunity,
          violation_type: v.violationType,
        })),
        alternatives,
        override: "Add '// @unerr-allow cross-community: [reason]' to bypass",
      },
    };
  }

  getSessionStats(): {
    violationsBlocked: number;
    typeImportsAllowed: number;
    overridesRecorded: number;
    autoBridges: number;
  } {
    let autoBridges = 0;
    for (const bridge of this.bridges.values()) {
      if (bridge.autoBridged) autoBridges++;
    }
    return {
      violationsBlocked: this.violationsBlocked,
      typeImportsAllowed: this.typeImportsAllowed,
      overridesRecorded: this.overridesRecorded,
      autoBridges,
    };
  }

  getBridges(): Map<string, BridgeRecord> {
    return new Map(this.bridges);
  }

  private async resolveTargetCommunity(
    importSpecifier: string,
    sourceFile: string
  ): Promise<{ id: number; label: string } | null> {
    if (!this.graph) return null;

    const resolvedPath = resolveImportPath(importSpecifier, sourceFile);
    if (!resolvedPath) return null;

    const targetEntities = await this.graph.getEntitiesByFile(resolvedPath);
    if (targetEntities.length === 0) return null;

    const community = await this.graph.getCommunityForEntity(
      targetEntities[0]!.key
    );
    if (!community) return null;

    return { id: community.id, label: community.label };
  }

  private async recordOverride(
    sourceCommunityId: number,
    _targetPath: string,
    _sourceFile: string
  ): Promise<void> {
    const targetCommunity = await this.resolveTargetCommunity(
      _targetPath,
      _sourceFile
    );
    if (!targetCommunity) return;

    const bridgeKey = `${sourceCommunityId}→${targetCommunity.id}`;
    const existing = this.bridges.get(bridgeKey);

    if (existing) {
      existing.overrideCount++;
      if (
        existing.overrideCount >= this.guardConfig.bridgeThreshold &&
        !existing.autoBridged
      ) {
        existing.autoBridged = true;
      }
    } else {
      this.bridges.set(bridgeKey, {
        sourceCommunity: sourceCommunityId,
        targetCommunity: targetCommunity.id,
        overrideCount: 1,
        autoBridged: false,
      });
    }
  }
}

interface ParsedImport {
  raw: string;
  specifier: string;
  isTypeOnly: boolean;
  hasOverride: boolean;
  resolvedPath: string | null;
}

function parseImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    const importMatch = line.match(
      /^import\s+(type\s+)?(?:\{[^}]*\}|[^'"]+)\s+from\s+['"]([^'"]+)['"]/
    );
    if (!importMatch) continue;

    const isTypeOnly = !!importMatch[1];
    const specifier = importMatch[2]!;

    if (!specifier.startsWith(".")) continue;

    const prevLine = i > 0 ? (lines[i - 1]?.trim() ?? "") : "";
    const hasOverride =
      OVERRIDE_PATTERN.test(prevLine) || OVERRIDE_PATTERN.test(line);

    results.push({
      raw: line,
      specifier,
      isTypeOnly,
      hasOverride,
      resolvedPath: null,
    });
  }

  return results;
}

function resolveImportPath(
  specifier: string,
  sourceFile: string
): string | null {
  if (!specifier.startsWith(".")) return null;

  const sourceParts = sourceFile.split("/");
  sourceParts.pop();

  const specParts = specifier.split("/");
  const resolved = [...sourceParts];

  for (const part of specParts) {
    if (part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  let result = resolved.join("/");
  if (!result.match(/\.[jt]sx?$/)) {
    result += ".ts";
  }
  return result;
}

function extractFilePath(args: Record<string, unknown>): string | null {
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.file === "string") return args.file;
  return null;
}

function extractNewContent(args: Record<string, unknown>): string | null {
  if (typeof args.new_str === "string") return args.new_str;
  if (typeof args.new_string === "string") return args.new_string;
  if (typeof args.content === "string") return args.content;
  if (typeof args.after === "string") return args.after;
  return null;
}

function isCodeFile(filePath: string): boolean {
  return /\.[jt]sx?$/.test(filePath);
}
