/**
 * Incomplete Work Detection — BA-2.1
 *
 * Session-end scan that flags broken callers — an entity whose signature
 * changed this session while one or more of its callers were never updated.
 * Reconciles the session edit-log (populated by the post-edit hook) against the
 * warm graph via the shared blast-radius engine.
 *
 * Persists flagged items to disk; the next session's resume block
 * (session-persistence.ts → formatSessionResumeBlock) surfaces them.
 *
 * (The original BA-2.1 also scanned the MCP shadow ledger for orphaned imports
 * and untested exports. Both were retired in the 2026-05 behavior-automation
 * audit: they keyed on edit/delete tool names that never enter the MCP ledger —
 * the agent's edits are Claude Code client tools, not MCP calls — so neither
 * could ever fire in production.)
 *
 * Trigger: session_end (proxy shutdown)
 * Assertiveness: suggestion (surface as checklist, don't block)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type IncompleteCaller,
  reconcileIncompleteCallers,
} from "../intelligence/edit-impact.js";
import type { CozoGraphStore } from "../intelligence/local-graph.js";
import type { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { readEditLog } from "../tracking/session-edit-log.js";
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
  private unerrDir: string | null = null;
  private behaviorEvents: BehaviorEventWriter | null = null;

  constructor(config?: Partial<IncompleteWorkConfig>) {
    super(config, "suggestion");
  }

  attachGraph(graph: CozoGraphStore): void {
    this.graph = graph;
  }

  setUnerrDir(dir: string): void {
    this.unerrDir = dir;
  }

  /** Inject the behavior-event writer so a `broken_callers` finding at
   *  session end lands in `behavior_events` (dashboard telemetry), not only
   *  `incomplete-work.json`. Optional — the detector works without it. */
  setBehaviorEvents(writer: BehaviorEventWriter): void {
    this.behaviorEvents = writer;
  }

  async onSessionEnd(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const items: IncompleteItem[] = [];

    const brokenCallers = await this.detectBrokenCallers();
    items.push(...brokenCallers);

    if (items.length === 0) return null;

    items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    const highCount = items.filter((i) => i.severity === "high").length;
    const summary =
      highCount > 0
        ? `${highCount} item(s) will cause immediate errors. Fix before committing.`
        : `${items.length} potential issue(s) detected. Review before your next session.`;

    const persisted = this.persistItems(items);

    // Telemetry: surface the session-end finding so the dashboard's
    // behavior-event panes render it. Best-effort — never block shutdown.
    if (this.behaviorEvents) {
      try {
        this.behaviorEvents.record({
          session_id: this.behaviorEvents.sessionId,
          type: "incomplete_work_flagged",
          tool: null,
          entity_key: null,
          response_bytes: null,
          detail: {
            items: items.length,
            high_severity: highCount,
            entities: items
              .map((i) => i.entity)
              .filter((e): e is string => Boolean(e)),
          },
        });
      } catch {
        /* best-effort — telemetry never blocks session end */
      }
    }

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
   * Reconcile this session's recorded edits against the graph (P2.2): for every
   * signature change made this session, flag callers whose file was never itself
   * edited. Reads the session edit-log the post-edit hook populates (the MCP
   * ledger can't — edits don't traverse MCP) and resolves callers through the
   * shared blast-radius engine.
   */
  private async detectBrokenCallers(): Promise<IncompleteItem[]> {
    if (!this.graph || !this.unerrDir) return [];

    const events = readEditLog(this.unerrDir);
    if (events.length === 0) return [];

    const incomplete = await reconcileIncompleteCallers(events, this.graph);
    if (incomplete.length === 0) return [];

    // One item per changed entity, listing the callers left un-updated.
    const byEntity = new Map<string, IncompleteCaller[]>();
    for (const c of incomplete) {
      const arr = byEntity.get(c.changed_entity) ?? [];
      arr.push(c);
      byEntity.set(c.changed_entity, arr);
    }

    const items: IncompleteItem[] = [];
    for (const [entity, callers] of byEntity) {
      const remaining = callers.map(
        (c) => `${c.caller_file}:${c.caller_entity}`
      );
      items.push({
        severity: "high",
        type: "broken_callers",
        entity,
        detail: `Signature changed (${callers[0]!.change_type}) but ${remaining.length} caller(s) not updated this session`,
        remaining,
        impact: "Callers will fail at runtime or compile time",
      });
    }

    return items;
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
