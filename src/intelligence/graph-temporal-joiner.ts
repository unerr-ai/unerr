/**
 * GraphTemporalJoiner — combines graph topology with temporal facts
 * to predict co-change patterns and detect hidden coupling.
 *
 * Part of Layer A of the Three-Layer Experience System.
 *
 * Co-change prediction: "when you change file A, you likely need to change file B"
 * Hidden coupling: files that always co-change but have no structural connection.
 *
 * Combined score formula: 0.4 * graph_coupling + 0.6 * temporal_coupling
 * (temporal is weighted higher — actual editing patterns are more predictive
 * than static structure)
 */

import type { CozoGraphStore } from "./local-graph.js";
import type { TemporalFact, TemporalFactStore } from "./temporal-facts.js";

export interface CoChangeSignal {
  file_a: string;
  file_b: string;
  /** Structural coupling from shared edges / import relationships (0-1) */
  graph_coupling: number;
  /** Behavioral coupling from co-access across sessions (0-1) */
  temporal_coupling: number;
  /** Weighted combination: 0.4 * graph + 0.6 * temporal */
  combined_score: number;
  /** Human-readable evidence string */
  evidence: string;
}

export interface HiddenCoupling {
  file_a: string;
  file_b: string;
  /** High temporal coupling (>0.5) */
  temporal_coupling: number;
  /** Low graph coupling (<0.1) — no structural connection */
  graph_coupling: number;
  /** Number of sessions that showed this pattern */
  sessions_observed: number;
  /** Human-readable evidence string */
  evidence: string;
}

export class GraphTemporalJoiner {
  constructor(
    private localGraph: CozoGraphStore,
    private factStore: TemporalFactStore | null
  ) {}

  /**
   * Predict which files are likely to need changes when targetFile changes.
   * Combines graph structure (imports/calls) with temporal facts (co-change history).
   */
  async predictCoChanges(targetFile: string): Promise<CoChangeSignal[]> {
    const [graphNeighbors, temporalCouplings] = await Promise.all([
      this.getGraphNeighbors(targetFile),
      this.getTemporalCouplings(targetFile),
    ]);

    // Merge graph and temporal signals by file
    const merged = new Map<
      string,
      {
        graph: number;
        temporal: number;
        graphEvidence: string;
        temporalEvidence: string;
      }
    >();

    for (const [file, score, evidence] of graphNeighbors) {
      if (file === targetFile) continue;
      merged.set(file, {
        graph: score,
        temporal: 0,
        graphEvidence: evidence,
        temporalEvidence: "",
      });
    }

    for (const [file, score, evidence] of temporalCouplings) {
      if (file === targetFile) continue;
      const existing = merged.get(file);
      if (existing) {
        existing.temporal = score;
        existing.temporalEvidence = evidence;
      } else {
        merged.set(file, {
          graph: 0,
          temporal: score,
          graphEvidence: "",
          temporalEvidence: evidence,
        });
      }
    }

    // Compute combined scores and sort
    const signals: CoChangeSignal[] = [];
    for (const [file, data] of merged) {
      const combined = 0.4 * data.graph + 0.6 * data.temporal;
      if (combined < 0.1) continue; // Filter noise

      const evidenceParts: string[] = [];
      if (data.graphEvidence) evidenceParts.push(data.graphEvidence);
      if (data.temporalEvidence) evidenceParts.push(data.temporalEvidence);

      signals.push({
        file_a: targetFile,
        file_b: file,
        graph_coupling: data.graph,
        temporal_coupling: data.temporal,
        combined_score: Math.round(combined * 100) / 100,
        evidence: evidenceParts.join(" + "),
      });
    }

    return signals.sort((a, b) => b.combined_score - a.combined_score);
  }

  /**
   * Detect hidden couplings — files with high temporal coupling but no graph edges.
   * These are the most dangerous: changes can silently break co-dependent files.
   */
  async detectHiddenCouplings(): Promise<HiddenCoupling[]> {
    if (!this.factStore) return [];

    // Get all coupling facts from temporal store
    const couplingFacts = await this.getCouplingFacts();
    const hidden: HiddenCoupling[] = [];

    for (const fact of couplingFacts) {
      const { fileA, fileB, score, sessions } = this.parseCouplingFact(fact);
      if (!fileA || !fileB || score < 0.5) continue;

      // Check if there's a structural connection
      const graphCoupling = await this.getGraphCouplingBetween(fileA, fileB);

      if (graphCoupling < 0.1) {
        hidden.push({
          file_a: fileA,
          file_b: fileB,
          temporal_coupling: score,
          graph_coupling: graphCoupling,
          sessions_observed: sessions,
          evidence: `Co-changed in ${sessions} sessions but no import/call edges`,
        });
      }
    }

    return hidden.sort((a, b) => b.temporal_coupling - a.temporal_coupling);
  }

  /**
   * Get graph-based neighbors for a file (via imports/calls).
   * Returns [filePath, couplingScore, evidence] tuples.
   */
  private async getGraphNeighbors(
    filePath: string
  ): Promise<Array<[string, number, string]>> {
    const neighbors: Array<[string, number, string]> = [];

    try {
      // Get entities in this file and their callers/callees
      const entities = await this.localGraph.getEntitiesByFile(filePath);
      if (!entities || entities.length === 0) return neighbors;

      const fileCounts = new Map<string, number>();

      for (const entity of entities.slice(0, 10)) {
        const [callers, callees] = await Promise.all([
          this.localGraph.getCallersOf(entity.key),
          this.localGraph.getCalleesOf(entity.key),
        ]);

        for (const caller of callers) {
          if (caller.file_path && caller.file_path !== filePath) {
            fileCounts.set(
              caller.file_path,
              (fileCounts.get(caller.file_path) ?? 0) + 1
            );
          }
        }

        for (const callee of callees) {
          if (callee.file_path && callee.file_path !== filePath) {
            fileCounts.set(
              callee.file_path,
              (fileCounts.get(callee.file_path) ?? 0) + 1
            );
          }
        }
      }

      // Normalize: max edges → 1.0
      const maxCount = Math.max(...fileCounts.values(), 1);
      for (const [file, count] of fileCounts) {
        const score = Math.min(1.0, count / maxCount);
        neighbors.push([file, score, `${count} shared edges`]);
      }
    } catch {
      // Graph query failure is non-critical
    }

    return neighbors;
  }

  /**
   * Get temporal coupling facts for a file.
   * Returns [filePath, couplingScore, evidence] tuples.
   */
  private async getTemporalCouplings(
    filePath: string
  ): Promise<Array<[string, number, string]>> {
    if (!this.factStore) return [];

    try {
      const facts = await this.factStore.recallBySubject(
        `coupling:${filePath}`,
        0.2
      );

      const couplings: Array<[string, number, string]> = [];
      for (const fact of facts) {
        const parsed = this.parseCouplingFact(fact);
        if (!parsed.fileB) continue;

        const otherFile =
          parsed.fileA === filePath ? parsed.fileB : parsed.fileA;
        if (!otherFile) continue;

        couplings.push([
          otherFile,
          parsed.score,
          `co-changed in ${parsed.sessions} sessions`,
        ]);
      }

      return couplings;
    } catch {
      return [];
    }
  }

  /**
   * Get all coupling facts from the temporal store.
   */
  private async getCouplingFacts(): Promise<TemporalFact[]> {
    if (!this.factStore) return [];

    try {
      const allFacts = await this.factStore.recallByScope("project", 0.2);
      return allFacts.filter(
        (f) => f.fact_type === "semantic" && f.subject.startsWith("coupling:")
      );
    } catch {
      return [];
    }
  }

  /**
   * Parse a coupling fact's subject and content.
   * Subject format: "coupling:fileA↔fileB"
   * Content format: "Files co-accessed in N sessions"
   */
  private parseCouplingFact(fact: TemporalFact): {
    fileA: string;
    fileB: string;
    score: number;
    sessions: number;
  } {
    const parts = fact.subject.replace("coupling:", "").split("↔");
    const fileA = parts[0] ?? "";
    const fileB = parts[1] ?? "";

    // Extract session count from content
    const sessionMatch = fact.content.match(/(\d+)\s*session/);
    const sessions = sessionMatch?.[1]
      ? Number.parseInt(sessionMatch[1], 10)
      : 1;

    return {
      fileA,
      fileB,
      score: fact.base_confidence,
      sessions,
    };
  }

  /**
   * Check structural coupling between two specific files.
   * Returns 0-1 based on shared edges.
   */
  private async getGraphCouplingBetween(
    fileA: string,
    fileB: string
  ): Promise<number> {
    try {
      const entitiesA = await this.localGraph.getEntitiesByFile(fileA);
      if (!entitiesA || entitiesA.length === 0) return 0;

      for (const entity of entitiesA.slice(0, 5)) {
        const [callers, callees] = await Promise.all([
          this.localGraph.getCallersOf(entity.key),
          this.localGraph.getCalleesOf(entity.key),
        ]);

        const hasConnection = [...callers, ...callees].some(
          (e) => e.file_path === fileB
        );
        if (hasConnection) return 0.5; // At least one structural connection
      }

      return 0;
    } catch {
      return 0;
    }
  }
}
