/**
 * SessionBriefBuilder — constructs a structured intelligence brief
 * for the first tool call of a session.
 *
 * Replaces flat session_greeting + session_resume with a structured
 * SessionBrief that includes inter-session changes, unfinished work,
 * key facts, convention summary, and intelligence health.
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
  /** Top 3 most relevant facts for current project */
  key_facts?: string[];
  /** Convention overview: "12 conventions detected, 94% avg adherence" */
  convention_summary?: string;
  /** Intelligence health: "42 facts, 12 conventions, 5 sessions" */
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
    private factStore: {
      recallByScope(
        scope: string,
        minConfidence?: number,
      ): Promise<
        Array<{
          fact_id: string;
          fact_type: string;
          content: string;
          effective_confidence: number;
          source: string;
        }>
      >;
    } | null,
    private graphStats: {
      entities: number;
      edges: number;
      rules: number;
    } | null,
    private healthGrade: string | null,
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

    // Gather async data in parallel
    const [keyFacts, conventionSummary] = await Promise.all([
      this.getKeyFacts(),
      this.getConventionSummary(),
    ]);

    if (keyFacts.length > 0) {
      brief.key_facts = keyFacts;
    }

    if (conventionSummary) {
      brief.convention_summary = conventionSummary;
    }

    // Intelligence health from graph stats + fact count
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
   * Get top 3 most relevant project-scope facts.
   */
  private async getKeyFacts(): Promise<string[]> {
    if (!this.factStore) return [];

    try {
      const facts = await this.factStore.recallByScope("project", 0.4);
      return facts
        .sort((a, b) => b.effective_confidence - a.effective_confidence)
        .slice(0, 3)
        .map((f) => f.content);
    } catch {
      return [];
    }
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
          conventions.length,
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

    if (this.factStore) {
      try {
        const facts = await this.factStore.recallByScope("project", 0.0);
        if (facts.length > 0) {
          parts.push(`${facts.length} facts`);
        }
      } catch {
        // Non-critical
      }
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

let instance: SessionBriefBuilder | null = null;

/**
 * Get or create the SessionBriefBuilder singleton.
 * Must be re-created if graph/facts change (call resetSessionBriefBuilder).
 */
export function getSessionBriefBuilder(
  localGraph: CozoGraphStore | null,
  factStore: SessionBriefBuilder["factStore"],
  graphStats: { entities: number; edges: number; rules: number } | null,
  healthGrade: string | null,
): SessionBriefBuilder {
  if (!instance) {
    instance = new SessionBriefBuilder(
      localGraph,
      factStore,
      graphStats,
      healthGrade,
    );
  }
  return instance;
}

export function resetSessionBriefBuilder(): void {
  instance = null;
}
