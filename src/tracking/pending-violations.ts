/**
 * Sprint 7.3: Pending Violation Store — push-based rule enforcement safety net.
 *
 * Stores rule violations detected by file-watcher-triggered rule evaluation.
 * Violations attach to the internal `context` carrier on the next MCP response
 * and surface as `ur|wrn` prefix lines (then cleared).
 *
 * Flow:
 *   File change → DriftTracker → evaluateRules → store violations here
 *   Next MCP tool call → QueryRouter drains pending violations → `ur|wrn` prefix lines
 */

import type { RuleViolation } from "../intelligence/rule-evaluator.js";

/** Compact violation surfaced via `ur|wrn` prefix line (<50 tokens each). */
export interface PendingViolation {
  file: string;
  rule: string;
  message: string;
  line?: number;
}

export class PendingViolationStore {
  private violations = new Map<string, PendingViolation[]>();

  /**
   * Add violations from a file change. Replaces any existing violations for that file.
   */
  addViolations(filePath: string, violations: RuleViolation[]): void {
    if (violations.length === 0) {
      this.violations.delete(filePath);
      return;
    }
    this.violations.set(
      filePath,
      violations.map((v) => ({
        file: v.filePath,
        rule: v.ruleName,
        message: v.message,
        line: v.line,
      }))
    );
  }

  /**
   * Drain all pending violations — returns them and clears the store.
   * Returns undefined if no violations pending.
   */
  drain(): PendingViolation[] | undefined {
    if (this.violations.size === 0) return undefined;
    const all: PendingViolation[] = [];
    for (const [, vs] of this.violations) {
      all.push(...vs);
    }
    this.violations.clear();
    return all;
  }

  /**
   * Drain violations for specific files only.
   * Returns undefined if no violations pending for those files.
   */
  drainForFiles(filePaths: string[]): PendingViolation[] | undefined {
    const result: PendingViolation[] = [];
    for (const fp of filePaths) {
      const vs = this.violations.get(fp);
      if (vs) {
        result.push(...vs);
        this.violations.delete(fp);
      }
    }
    return result.length > 0 ? result : undefined;
  }

  /** Check if any violations are pending. */
  get hasPending(): boolean {
    return this.violations.size > 0;
  }

  /** Total number of pending violations across all files. */
  get count(): number {
    let total = 0;
    for (const [, vs] of this.violations) {
      total += vs.length;
    }
    return total;
  }

  /** Clear all pending violations. */
  clear(): void {
    this.violations.clear();
  }
}
