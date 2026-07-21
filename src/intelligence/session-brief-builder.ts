/**
 * SessionBriefBuilder — constructs a structured intelligence brief
 * for the first tool call of a session.
 *
 * Replaces flat session_greeting + session_resume with a structured
 * SessionBrief that includes inter-session changes, unfinished work,
 * convention summary, and intelligence health. Graph-only — sourced
 * entirely from `CozoGraphStore`, no fact-store dependency.
 *
 * Part of Layer B of the Three-Layer Experience System.
 */

import type { CozoGraphStore } from "./local-graph.js";

/** Structured session brief delivered on first tool call */
export interface SessionBrief {
  /** Session greeting line: "Session on unerr-cli (main branch)" */
  greeting: string;
  /** Files changed since last session (from resume context) */
  inter_session_changes?: string[];
  /** Entities with uncommitted changes from last session */
  unfinished_work?: string[];
  /** Convention overview: "12 conventions detected, 94% avg adherence" */
  convention_summary?: string;
  /** Intelligence health: "42 entities, 12 conventions" */
  intelligence_health?: string;
}

/** Resume data from the previous session (optional) */
export interface SessionResumeData {
  summary: string;
  filesModified: string[];
  incompleteEntities: string[];
}

export class SessionBriefBuilder {
  constructor(
    private localGraph: CozoGraphStore | null,
    private graphStats: {
      entities: number;
      edges: number;
      rules: number;
    } | null,
    private healthGrade: string | null
  ) {}

  /**
   * Build a structured session brief.
   * Gathers intelligence from graph, fact store, and resume context.
   */
  async build(resumeContext?: SessionResumeData | null): Promise<SessionBrief> {
    const brief: SessionBrief = {
      greeting: this.buildGreeting(),
    };

    // Inter-session changes from resume context
    if (
      resumeContext?.filesModified &&
      resumeContext.filesModified.length > 0
    ) {
      brief.inter_session_changes = resumeContext.filesModified.slice(0, 10);
    }

    // Unfinished work from resume context
    if (
      resumeContext?.incompleteEntities &&
      resumeContext.incompleteEntities.length > 0
    ) {
      brief.unfinished_work = resumeContext.incompleteEntities.slice(0, 5);
    }

    const conventionSummary = await this.getConventionSummary();
    if (conventionSummary) {
      brief.convention_summary = conventionSummary;
    }

    // Intelligence health from graph stats
    const health = await this.getIntelligenceHealth();
    if (health) {
      brief.intelligence_health = health;
    }

    return brief;
  }

  /**
   * Build the greeting line based on codebase health grade.
   */
  private buildGreeting(): string {
    if (!this.healthGrade || !this.graphStats) {
      return "unerr proxy ready. Graph intelligence active.";
    }

    const { entities, edges, rules } = this.graphStats;
    const grade = this.healthGrade;

    if (grade === "A" || grade === "A+") {
      return `Codebase scores ${grade} — ${entities} entities, ${edges} edges, ${rules} rules. Architecture is healthy.`;
    }
    if (grade === "B" || grade === "B+") {
      return `Codebase health: ${grade}. Tracking ${entities} entities, ${edges} edges, ${rules} rules. Some areas could improve.`;
    }
    if (grade.startsWith("C")) {
      return `Codebase health: ${grade}. ${entities} entities tracked, ${rules} rules active. Structural issues affect maintainability.`;
    }
    return `Warning: codebase health is ${grade}. Significant structural issues across ${entities} entities.`;
  }

  /**
   * Get convention summary from graph store.
   */
  private async getConventionSummary(): Promise<string | null> {
    if (!this.localGraph) return null;

    try {
      const conventions = await this.localGraph.getConventions();
      if (!conventions || conventions.length === 0) return null;

      const avgAdherence = Math.round(
        conventions.reduce((sum, c) => sum + c.adherence_rate, 0) /
          conventions.length
      );
      return `${conventions.length} conventions detected, ${avgAdherence}% avg adherence`;
    } catch {
      return null;
    }
  }

  /**
   * Get intelligence health summary.
   */
  private async getIntelligenceHealth(): Promise<string | null> {
    const parts: string[] = [];

    if (this.graphStats) {
      parts.push(`${this.graphStats.entities} entities`);
    }

    if (this.localGraph) {
      try {
        const conventions = await this.localGraph.getConventions();
        if (conventions && conventions.length > 0) {
          parts.push(`${conventions.length} conventions`);
        }
      } catch {
        // Non-critical
      }
    }

    return parts.length > 0 ? parts.join(", ") : null;
  }
}

/**
 * Render a SessionBrief as a visible `[unerr:session-resume]` block that
 * can be prepended to the first tool response's text content.
 *
 * The block exists because MCP clients filter `_meta` out before reaching
 * the agent, so the structured brief never lands in the model's context.
 * Emitting the same intel inline keeps it visible at the wire boundary.
 *
 * Returns "" when the brief has nothing user-facing to surface (a bare
 * greeting alone is not worth the tokens — those land in `_meta` only).
 */
export function formatBriefAsVisibleBlock(
  brief: SessionBrief,
  elapsedMs?: number
): string {
  const lines: string[] = [];
  const elapsed = elapsedMs ? formatElapsed(elapsedMs) : null;
  const files = brief.inter_session_changes ?? [];

  // First line — only emit when there's something concrete to say. A
  // bare "Previous session (?)" with no files is noise.
  if (files.length > 0) {
    const filesStr = files.slice(0, 3).join(", ");
    const prefix = elapsed
      ? `Previous session (${elapsed} ago)`
      : "Previous session";
    lines.push(`[unerr:session-resume] ${prefix}: worked on ${filesStr}.`);
  } else if (elapsed) {
    lines.push(`[unerr:session-resume] Previous session ${elapsed} ago.`);
  }

  if (brief.unfinished_work && brief.unfinished_work.length > 0) {
    const incomplete = brief.unfinished_work.slice(0, 3).join(", ");
    lines.push(`▸ Incomplete from last session: ${incomplete}.`);
  }

  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

let instance: SessionBriefBuilder | null = null;

/**
 * Get or create the SessionBriefBuilder singleton.
 * Must be re-created if the graph changes (call resetSessionBriefBuilder).
 */
export function getSessionBriefBuilder(
  localGraph: CozoGraphStore | null,
  graphStats: { entities: number; edges: number; rules: number } | null,
  healthGrade: string | null
): SessionBriefBuilder {
  if (!instance) {
    instance = new SessionBriefBuilder(localGraph, graphStats, healthGrade);
  }
  return instance;
}

export function resetSessionBriefBuilder(): void {
  instance = null;
}
