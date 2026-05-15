/**
 * Incomplete Work Detection — BA-2.1
 *
 * Session-end scan that verifies:
 *   1. Broken callers — entity signature changed but callers not all updated
 *   2. Orphaned imports — import targets deleted during session
 *   3. Untested exports — new exported symbols with no test reference
 *
 * Persists incomplete items to disk so Session Continuity (BA-1.2) can
 * inject them as resume context in the next session.
 *
 * Trigger: session_end (proxy shutdown)
 * Assertiveness: suggestion (surface as checklist, don't block)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  CozoGraphStore,
  LocalEntity,
} from "../intelligence/local-graph.js";
import type { LedgerEntry, ShadowLedger } from "../tracking/shadow-ledger.js";
import type { CascadeConsistencyGuard } from "./cascade-guard.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";

export type IncompleteItemSeverity = "high" | "medium" | "low";
export type IncompleteItemType =
  | "broken_callers"
  | "orphaned_import"
  | "untested_path";

export interface IncompleteItem {
  severity: IncompleteItemSeverity;
  type: IncompleteItemType;
  entity?: string;
  file?: string;
  detail: string;
  remaining?: string[];
  impact: string;
}

export interface IncompleteWorkResult {
  items: IncompleteItem[];
  summary: string;
  persisted: boolean;
}

const PERSISTENCE_FILE = "incomplete-work.json";

export interface IncompleteWorkConfig {
  enabled: boolean;
  level: AssertLevel;
  checkOnSessionEnd: boolean;
}

export class IncompleteWorkDetector extends Behavior {
  readonly id = "incomplete_work";
  readonly hooks = ["session_end"] as const;
  readonly defaultLevel: AssertLevel = "suggestion";

  private graph: CozoGraphStore | null = null;
  private ledger: ShadowLedger | null = null;
  private cascadeGuard: CascadeConsistencyGuard | null = null;
  private unerrDir: string | null = null;

  constructor(config?: Partial<IncompleteWorkConfig>) {
    super(config, "suggestion");
  }

  attachGraph(graph: CozoGraphStore): void {
    this.graph = graph;
  }

  attachLedger(ledger: ShadowLedger): void {
    this.ledger = ledger;
  }

  attachCascadeGuard(cascadeGuard: CascadeConsistencyGuard): void {
    this.cascadeGuard = cascadeGuard;
  }

  setUnerrDir(dir: string): void {
    this.unerrDir = dir;
  }

  async onSessionEnd(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const items: IncompleteItem[] = [];

    const brokenCallers = this.detectBrokenCallers();
    items.push(...brokenCallers);

    const orphanedImports = await this.detectOrphanedImports();
    items.push(...orphanedImports);

    const untestedExports = await this.detectUntestedExports();
    items.push(...untestedExports);

    if (items.length === 0) return null;

    items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    const highCount = items.filter((i) => i.severity === "high").length;
    const summary =
      highCount > 0
        ? `${highCount} item(s) will cause immediate errors. Fix before committing.`
        : `${items.length} potential issue(s) detected. Review before your next session.`;

    const persisted = this.persistItems(items);

    return {
      behaviorId: this.id,
      level: this.level,
      relatedSkillId: "dependency-aware-refactor",
      _meta: {
        behavior: this.id,
        items_found: items.length,
        high_severity: highCount,
        persisted,
      },
      _context: {
        incomplete_items: items,
        summary,
      },
    };
  }

  /**
   * Check cascade guard for signature changes where not all callers were updated.
   */
  private detectBrokenCallers(): IncompleteItem[] {
    if (!this.cascadeGuard) return [];

    const incompleteChanges = this.cascadeGuard.getIncompleteChanges();
    const items: IncompleteItem[] = [];

    for (const change of incompleteChanges) {
      const remaining = change.callersAtRisk
        .filter((c) => !change.callersUpdated.has(c.entity))
        .map((c) => `${c.file}:${c.entity}`);

      if (remaining.length === 0) continue;

      items.push({
        severity: "high",
        type: "broken_callers",
        entity: change.entityKey,
        detail: `Signature changed (${change.changeType}) but ${remaining.length}/${change.callersAtRisk.length} callers not updated`,
        remaining,
        impact: "Callers will fail at runtime or compile time",
      });
    }

    return items;
  }

  /**
   * Check shadow ledger for files that were deleted but are still imported.
   * Uses the graph to find import edges pointing to deleted files.
   */
  private async detectOrphanedImports(): Promise<IncompleteItem[]> {
    if (!this.ledger || !this.graph) return [];

    const sessionEntries = this.ledger.getRecentEntries(100);
    const deletedFiles = new Set<string>();

    for (const entry of sessionEntries) {
      if (entry.tool === "delete_file" || entry.tool === "remove_file") {
        const path = extractPathFromArgs(entry.args_summary);
        if (path) deletedFiles.add(path);
      }
    }

    if (deletedFiles.size === 0) return [];

    const items: IncompleteItem[] = [];
    for (const deletedFile of deletedFiles) {
      const importers = await this.findImportersOf(deletedFile);
      if (importers.length > 0) {
        items.push({
          severity: "medium",
          type: "orphaned_import",
          file: deletedFile,
          detail: `File deleted this session but still imported by ${importers.length} file(s)`,
          remaining: importers.slice(0, 5),
          impact: "Runtime import error",
        });
      }
    }

    return items;
  }

  /**
   * Find new exports added this session that have no test coverage.
   */
  private async detectUntestedExports(): Promise<IncompleteItem[]> {
    if (!this.ledger || !this.graph) return [];

    const sessionEntries = this.ledger.getRecentEntries(100);
    const modifiedFiles = new Set<string>();

    for (const entry of sessionEntries) {
      if (isEditTool(entry.tool)) {
        const path = extractPathFromArgs(entry.args_summary);
        if (path && !isTestFile(path)) modifiedFiles.add(path);
      }
    }

    const items: IncompleteItem[] = [];
    for (const file of modifiedFiles) {
      const entities = await this.graph.getEntitiesByFile(file);
      for (const entity of entities) {
        if (entity.kind !== "function" && entity.kind !== "class") continue;
        if (entity.fan_in === 0) {
          const hasTestRef = await this.hasTestReference(entity);
          if (!hasTestRef) {
            items.push({
              severity: "low",
              type: "untested_path",
              entity: entity.name,
              file: entity.file_path,
              detail: `Exported ${entity.kind} "${entity.name}" has no test references`,
              impact: "Regression risk — no test coverage",
            });
          }
        }
      }
    }

    return items;
  }

  private async findImportersOf(filePath: string): Promise<string[]> {
    if (!this.graph) return [];
    const entities = await this.graph.getEntitiesByFile(filePath);
    const importerFiles = new Set<string>();
    for (const entity of entities) {
      const callers = await this.graph.getCallersOf(entity.key);
      for (const caller of callers) {
        if (caller.file_path !== filePath) {
          importerFiles.add(caller.file_path);
        }
      }
    }
    return [...importerFiles];
  }

  private async hasTestReference(entity: LocalEntity): Promise<boolean> {
    if (!this.graph) return false;
    const callers = await this.graph.getCallersOf(entity.key);
    return callers.some((c) => isTestFile(c.file_path));
  }

  private persistItems(items: IncompleteItem[]): boolean {
    if (!this.unerrDir) return false;
    try {
      const stateDir = join(this.unerrDir, "state");
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
      const filePath = join(stateDir, PERSISTENCE_FILE);
      writeFileSync(
        filePath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          items,
        }),
        "utf-8"
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read persisted incomplete items from the previous session.
   * Used by Session Continuity (BA-1.2).
   */
  static readPersistedItems(unerrDir: string): IncompleteItem[] {
    try {
      const filePath = join(unerrDir, "state", PERSISTENCE_FILE);
      if (!existsSync(filePath)) return [];
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as {
        items: IncompleteItem[];
      };
      return data.items ?? [];
    } catch {
      return [];
    }
  }
}

function severityRank(severity: IncompleteItemSeverity): number {
  switch (severity) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
  }
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
  "sync_local_diff",
]);

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

function extractPathFromArgs(args: Record<string, unknown>): string | null {
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.file === "string") return args.file;
  if (typeof args.key === "string" && args.key.includes("/")) {
    return args.key.includes("::") ? args.key.split("::")[0]! : args.key;
  }
  return null;
}
