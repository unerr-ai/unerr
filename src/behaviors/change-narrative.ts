/**
 * Change Impact Narrative — BA-3.2
 *
 * Session-end synthesis: combines signals from ALL behaviors (cascade guard,
 * convention drift, incomplete work, architecture boundary) into a structured
 * markdown summary suitable for PR descriptions or commit messages.
 *
 * Risk levels computed from the aggregate of all behavior signals:
 *   - critical: architecture violations or broken callers
 *   - high: multiple convention violations or incomplete work
 *   - medium: minor convention drift or documentation gaps
 *   - low: clean session
 *
 * Uses counterfactual framing: "Without unerr, X would have..."
 */

import {
  calculateDollarSavings,
  formatDollars,
} from "../proxy/model-pricing.js";
import type { ArchitectureBoundaryGuard } from "./architecture-guard.js";
import type { AutoDocBehavior } from "./auto-doc.js";
import type { CascadeConsistencyGuard } from "./cascade-guard.js";
import type { ConventionDriftPrevention } from "./convention-drift.js";
import {
  type AssertLevel,
  Behavior,
  type BehaviorOutput,
  type ToolCallContext,
} from "./framework.js";
import type { IncompleteWorkDetector } from "./incomplete-work.js";
import type { LoopCircuitBreaker } from "./loop-breaker.js";

export type RiskLevel = "critical" | "high" | "medium" | "low";

export interface NarrativeSection {
  title: string;
  status: "pass" | "warn" | "fail";
  items: string[];
}

export interface ChangeNarrativeResult {
  riskLevel: RiskLevel;
  sections: NarrativeSection[];
  markdown: string;
  counterfactual: string;
}

export class ChangeNarrativeBehavior extends Behavior {
  readonly id = "change_narrative";
  readonly hooks = ["session_end"] as const;
  readonly defaultLevel: AssertLevel = "suggestion";

  private cascadeGuard: CascadeConsistencyGuard | null = null;
  private conventionDrift: ConventionDriftPrevention | null = null;
  private incompleteWork: IncompleteWorkDetector | null = null;
  private architectureGuard: ArchitectureBoundaryGuard | null = null;
  private loopBreaker: LoopCircuitBreaker | null = null;
  private autoDoc: AutoDocBehavior | null = null;

  constructor(config?: Partial<{ enabled: boolean; level: AssertLevel }>) {
    super(config, "suggestion");
  }

  attachBehaviors(behaviors: {
    cascadeGuard?: CascadeConsistencyGuard;
    conventionDrift?: ConventionDriftPrevention;
    incompleteWork?: IncompleteWorkDetector;
    architectureGuard?: ArchitectureBoundaryGuard;
    loopBreaker?: LoopCircuitBreaker;
    autoDoc?: AutoDocBehavior;
  }): void {
    if (behaviors.cascadeGuard) this.cascadeGuard = behaviors.cascadeGuard;
    if (behaviors.conventionDrift)
      this.conventionDrift = behaviors.conventionDrift;
    if (behaviors.incompleteWork)
      this.incompleteWork = behaviors.incompleteWork;
    if (behaviors.architectureGuard)
      this.architectureGuard = behaviors.architectureGuard;
    if (behaviors.loopBreaker) this.loopBreaker = behaviors.loopBreaker;
    if (behaviors.autoDoc) this.autoDoc = behaviors.autoDoc;
  }

  async onSessionEnd(_ctx: ToolCallContext): Promise<BehaviorOutput | null> {
    const sections: NarrativeSection[] = [];

    sections.push(this.buildCascadeSection());
    sections.push(this.buildConventionSection());
    sections.push(this.buildArchitectureSection());
    sections.push(this.buildIncompleteSection());
    sections.push(this.buildLoopSection());
    sections.push(this.buildDocSection());

    const activeSections = sections.filter((s) => s.items.length > 0);
    if (activeSections.length === 0) return null;

    const riskLevel = computeRiskLevel(activeSections);
    const markdown = renderMarkdown(activeSections, riskLevel);
    const counterfactual = buildCounterfactual(
      activeSections,
      this.loopBreaker
    );

    return {
      behaviorId: this.id,
      level: this.level,
      _meta: {
        behavior: this.id,
        risk_level: riskLevel,
        sections_active: activeSections.length,
      },
      _context: {
        change_narrative: {
          risk_level: riskLevel,
          sections: activeSections,
          markdown,
          counterfactual,
        },
      },
    };
  }

  private buildCascadeSection(): NarrativeSection {
    const section: NarrativeSection = {
      title: "Cascade Status",
      status: "pass",
      items: [],
    };
    if (!this.cascadeGuard) return section;

    const stats = this.cascadeGuard.getSessionStats();
    if (stats.signatureChangesDetected > 0) {
      section.items.push(
        `${stats.signatureChangesDetected} signature change(s) detected, ${stats.totalCallersNotified} caller(s) notified`
      );
    }
    if (stats.incompleteUpdates > 0) {
      section.status = "fail";
      section.items.push(
        `${stats.incompleteUpdates} signature change(s) have callers NOT yet updated`
      );
    } else if (stats.signatureChangesDetected > 0) {
      section.status = "pass";
      section.items.push("All callers updated — no cascade risk");
    }

    return section;
  }

  private buildConventionSection(): NarrativeSection {
    const section: NarrativeSection = {
      title: "Convention Compliance",
      status: "pass",
      items: [],
    };
    if (!this.conventionDrift) return section;

    const stats = this.conventionDrift.getSessionStats();
    if (stats.violationsDetected > 0) {
      section.status =
        stats.autoFixes === stats.violationsDetected ? "warn" : "fail";
      section.items.push(
        `${stats.violationsDetected} convention violation(s), ${stats.autoFixes} auto-fixed`
      );
      if (stats.violationsDetected > stats.autoFixes) {
        section.items.push(
          `${stats.violationsDetected - stats.autoFixes} violation(s) require manual review`
        );
      }
    }

    return section;
  }

  private buildArchitectureSection(): NarrativeSection {
    const section: NarrativeSection = {
      title: "Architecture Check",
      status: "pass",
      items: [],
    };
    if (!this.architectureGuard) return section;

    const stats = this.architectureGuard.getSessionStats();
    if (stats.violationsBlocked > 0) {
      section.status = "fail";
      section.items.push(
        `${stats.violationsBlocked} cross-community import(s) blocked`
      );
    }
    if (stats.typeImportsAllowed > 0) {
      section.items.push(
        `${stats.typeImportsAllowed} type import(s) across boundaries (allowed)`
      );
    }
    if (stats.autoBridges > 0) {
      section.items.push(
        `${stats.autoBridges} auto-bridge rule(s) created from repeated overrides`
      );
    }

    return section;
  }

  private buildIncompleteSection(): NarrativeSection {
    const section: NarrativeSection = {
      title: "Incomplete Items",
      status: "pass",
      items: [],
    };
    if (!this.incompleteWork) return section;

    if (!this.cascadeGuard) return section;
    const changes = this.cascadeGuard.getIncompleteChanges();
    if (changes.length > 0) {
      section.status = "warn";
      section.items.push(
        `${changes.length} entity(s) with incomplete caller updates`
      );
      for (const change of changes.slice(0, 3)) {
        const remaining = change.callersAtRisk.filter(
          (c) => !change.callersUpdated.has(c.entity)
        );
        section.items.push(
          `  → ${change.entityKey}: ${remaining.length} caller(s) still need updating`
        );
      }
    }

    return section;
  }

  private buildLoopSection(): NarrativeSection {
    const section: NarrativeSection = {
      title: "Loop Prevention",
      status: "pass",
      items: [],
    };
    if (!this.loopBreaker) return section;

    const stats = this.loopBreaker.getSessionStats();
    if (stats.loopsPrevented > 0) {
      section.status = "warn";
      const dollars = calculateDollarSavings(stats.totalTokensSaved);
      section.items.push(
        `${stats.loopsPrevented} loop(s) prevented, saving ~${formatDollars(dollars)}`
      );
    }

    return section;
  }

  private buildDocSection(): NarrativeSection {
    const section: NarrativeSection = {
      title: "Documentation",
      status: "pass",
      items: [],
    };
    if (!this.autoDoc) return section;

    const stats = this.autoDoc.getSessionStats();
    if (stats.docsGenerated > 0) {
      section.items.push(`${stats.docsGenerated} doc(s) generated or updated`);
    }
    if (stats.docsFlagged > 0) {
      section.status = "warn";
      section.items.push(`${stats.docsFlagged} reference doc(s) may be stale`);
    }

    return section;
  }
}

function computeRiskLevel(sections: NarrativeSection[]): RiskLevel {
  const hasFailure = sections.some((s) => s.status === "fail");
  const failCount = sections.filter((s) => s.status === "fail").length;
  const warnCount = sections.filter((s) => s.status === "warn").length;

  if (failCount >= 2) return "critical";
  if (hasFailure) return "high";
  if (warnCount >= 2) return "medium";
  return "low";
}

function renderMarkdown(
  sections: NarrativeSection[],
  riskLevel: RiskLevel
): string {
  const statusIcon = (s: "pass" | "warn" | "fail"): string => {
    switch (s) {
      case "pass":
        return "✅";
      case "warn":
        return "⚠️";
      case "fail":
        return "❌";
    }
  };

  const riskBadge = (r: RiskLevel): string => {
    switch (r) {
      case "critical":
        return "🔴 CRITICAL";
      case "high":
        return "🟠 HIGH";
      case "medium":
        return "🟡 MEDIUM";
      case "low":
        return "🟢 LOW";
    }
  };

  const lines: string[] = [
    `## Change Impact: ${riskBadge(riskLevel)}`,
    "",
    "*Generated by unerr behavioral automation*",
    "",
  ];

  for (const section of sections) {
    lines.push(`### ${statusIcon(section.status)} ${section.title}`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildCounterfactual(
  sections: NarrativeSection[],
  loopBreaker: LoopCircuitBreaker | null
): string {
  const parts: string[] = [];

  const cascadeFails = sections.find(
    (s) => s.title === "Cascade Status" && s.status === "fail"
  );
  if (cascadeFails) {
    parts.push("broken callers would have gone unnoticed until runtime");
  }

  const convFails = sections.find(
    (s) => s.title === "Convention Compliance" && s.status !== "pass"
  );
  if (convFails) {
    parts.push("convention violations would have spread through the codebase");
  }

  const archFails = sections.find(
    (s) => s.title === "Architecture Check" && s.status === "fail"
  );
  if (archFails) {
    parts.push("cross-community imports would have degraded module boundaries");
  }

  if (loopBreaker) {
    const stats = loopBreaker.getSessionStats();
    if (stats.loopsPrevented > 0) {
      const dollars = calculateDollarSavings(stats.totalTokensSaved);
      parts.push(
        `~${formatDollars(dollars)} would have been wasted in retry loops`
      );
    }
  }

  if (parts.length === 0) {
    return "Clean session — no issues prevented.";
  }

  return `Without unerr, ${parts.join(", ")}.`;
}
