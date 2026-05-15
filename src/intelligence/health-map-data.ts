/**
 * HealthMapData — builds a hierarchical health map of the codebase.
 *
 * Combines CozoDB graph metrics (fan_in, fan_out, risk_level) with
 * temporal facts (change frequency, coupling count, durability) to
 * produce a per-file/per-directory health score.
 *
 * Part of Layer C of the Three-Layer Experience System.
 */

import type { CozoGraphStore } from "./local-graph.js";

/** Slim entity shape returned by getCriticalNodes */
interface GraphEntity {
  key: string;
  name: string;
  file_path: string;
  kind: string;
  fan_in: number;
  fan_out: number;
  risk_level: string;
}

/** Minimal fact store interface for health map. */
interface HealthFactStore {
  recallByScope(
    scope: string,
    minConfidence?: number
  ): Promise<
    Array<{
      fact_id: string;
      fact_type: string;
      subject: string;
      content: string;
      effective_confidence: number;
      source: string;
    }>
  >;
  recallForFile(filePath: string): Promise<
    Array<{
      fact_id: string;
      fact_type: string;
      subject: string;
      content: string;
      effective_confidence: number;
    }>
  >;
}

/** Risk level classification for health map nodes */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Metrics for a health map node */
export interface HealthMetrics {
  fan_in: number;
  fan_out: number;
  durability: number;
  convention_adherence: number;
  change_frequency: number;
  coupling_count: number;
}

/** A node in the health map tree */
export interface HealthMapNode {
  path: string;
  name: string;
  health_score: number;
  risk_level: RiskLevel;
  metrics: HealthMetrics;
  entity_count: number;
  children?: HealthMapNode[];
}

/**
 * Compute health score from metrics.
 *
 * Formula: 0.3*(1-normalized_risk) + 0.2*durability + 0.2*convention_adherence
 *        + 0.15*(1-normalized_coupling) + 0.15*(1-normalized_change_frequency)
 */
function computeHealthScore(metrics: HealthMetrics): number {
  const normalizedRisk = Math.min((metrics.fan_in + metrics.fan_out) / 40, 1.0);
  const normalizedCoupling = Math.min(metrics.coupling_count / 10, 1.0);
  const normalizedChangeFreq = Math.min(metrics.change_frequency / 10, 1.0);

  return (
    0.3 * (1 - normalizedRisk) +
    0.2 * metrics.durability +
    0.2 * metrics.convention_adherence +
    0.15 * (1 - normalizedCoupling) +
    0.15 * (1 - normalizedChangeFreq)
  );
}

/** Map health score to risk level. */
function scoreToRisk(score: number): RiskLevel {
  if (score >= 0.75) return "low";
  if (score >= 0.5) return "medium";
  if (score >= 0.25) return "high";
  return "critical";
}

export class HealthMapData {
  constructor(
    private localGraph: CozoGraphStore,
    private factStore: HealthFactStore | null
  ) {}

  /**
   * Build a hierarchical health map tree for the codebase.
   * Groups entities by directory, computes per-file and per-directory health.
   */
  async buildTree(rootPath?: string): Promise<HealthMapNode> {
    // Get all entities from graph
    const stats = await this.localGraph.getLocalProjectStats();
    const criticalNodes = await this.localGraph.getCriticalNodes(500);

    // Build entity-to-file map
    const fileEntities = new Map<string, GraphEntity[]>();
    for (const entity of criticalNodes) {
      const filePath = entity.file_path;
      if (rootPath && !filePath.startsWith(rootPath)) continue;
      const existing = fileEntities.get(filePath);
      if (existing) {
        existing.push(entity);
      } else {
        fileEntities.set(filePath, [entity]);
      }
    }

    // Get coupling facts for all files
    const couplingCounts = new Map<string, number>();
    const changeCounts = new Map<string, number>();

    if (this.factStore) {
      try {
        const projectFacts = await this.factStore.recallByScope("project", 0.0);
        for (const fact of projectFacts) {
          if (fact.subject.startsWith("coupling:")) {
            const pair = fact.subject.replace("coupling:", "");
            const files = pair.split("↔");
            for (const f of files) {
              if (f) couplingCounts.set(f, (couplingCounts.get(f) ?? 0) + 1);
            }
          }
        }

        // Count change frequency from episodic facts per file
        for (const filePath of fileEntities.keys()) {
          try {
            const fileFacts = await this.factStore.recallForFile(filePath);
            const episodic = fileFacts.filter(
              (f) => f.fact_type === "episodic"
            );
            if (episodic.length > 0) {
              changeCounts.set(filePath, episodic.length);
            }
          } catch {
            // Non-critical
          }
        }
      } catch {
        // Non-critical — proceed with graph-only data
      }
    }

    // Get convention adherence
    let avgAdherence = 0.8; // Default
    try {
      const conventions = await this.localGraph.getConventions();
      if (conventions && conventions.length > 0) {
        avgAdherence =
          conventions.reduce((sum, c) => sum + c.adherence_rate, 0) /
          conventions.length /
          100;
      }
    } catch {
      // Non-critical
    }

    // Build file nodes
    const fileNodes: HealthMapNode[] = [];
    for (const [filePath, entities] of fileEntities) {
      const totalFanIn = entities.reduce((s, e) => s + e.fan_in, 0);
      const totalFanOut = entities.reduce((s, e) => s + e.fan_out, 0);
      const highRiskCount = entities.filter(
        (e) => e.risk_level === "high" || e.risk_level === "critical"
      ).length;

      const metrics: HealthMetrics = {
        fan_in: totalFanIn,
        fan_out: totalFanOut,
        durability:
          highRiskCount > 0 ? Math.max(0.2, 1 - highRiskCount * 0.15) : 0.8,
        convention_adherence: avgAdherence,
        change_frequency: changeCounts.get(filePath) ?? 0,
        coupling_count: couplingCounts.get(filePath) ?? 0,
      };

      const healthScore = computeHealthScore(metrics);
      const name = filePath.split("/").pop() ?? filePath;

      fileNodes.push({
        path: filePath,
        name,
        health_score: Math.round(healthScore * 100) / 100,
        risk_level: scoreToRisk(healthScore),
        metrics,
        entity_count: entities.length,
      });
    }

    // Group into directory tree
    const dirMap = new Map<string, HealthMapNode[]>();
    for (const node of fileNodes) {
      const dir = node.path.split("/").slice(0, -1).join("/") || ".";
      const existing = dirMap.get(dir);
      if (existing) {
        existing.push(node);
      } else {
        dirMap.set(dir, [node]);
      }
    }

    // Build directory nodes
    const dirNodes: HealthMapNode[] = [];
    for (const [dirPath, children] of dirMap) {
      const dirHealth =
        children.reduce((s, c) => s + c.health_score, 0) / children.length;
      const totalEntities = children.reduce((s, c) => s + c.entity_count, 0);

      const aggregatedMetrics: HealthMetrics = {
        fan_in: children.reduce((s, c) => s + c.metrics.fan_in, 0),
        fan_out: children.reduce((s, c) => s + c.metrics.fan_out, 0),
        durability:
          children.reduce((s, c) => s + c.metrics.durability, 0) /
          children.length,
        convention_adherence:
          children.reduce((s, c) => s + c.metrics.convention_adherence, 0) /
          children.length,
        change_frequency: children.reduce(
          (s, c) => s + c.metrics.change_frequency,
          0
        ),
        coupling_count: children.reduce(
          (s, c) => s + c.metrics.coupling_count,
          0
        ),
      };

      dirNodes.push({
        path: dirPath,
        name: dirPath.split("/").pop() ?? dirPath,
        health_score: Math.round(dirHealth * 100) / 100,
        risk_level: scoreToRisk(dirHealth),
        metrics: aggregatedMetrics,
        entity_count: totalEntities,
        children: children.sort((a, b) => a.health_score - b.health_score),
      });
    }

    // Root node
    const rootHealth =
      dirNodes.length > 0
        ? dirNodes.reduce((s, d) => s + d.health_score, 0) / dirNodes.length
        : 0.5;
    const totalEntities = dirNodes.reduce((s, d) => s + d.entity_count, 0);

    return {
      path: rootPath ?? ".",
      name: rootPath?.split("/").pop() ?? "project",
      health_score: Math.round(rootHealth * 100) / 100,
      risk_level: scoreToRisk(rootHealth),
      metrics: {
        fan_in: dirNodes.reduce((s, d) => s + d.metrics.fan_in, 0),
        fan_out: dirNodes.reduce((s, d) => s + d.metrics.fan_out, 0),
        durability:
          dirNodes.length > 0
            ? dirNodes.reduce((s, d) => s + d.metrics.durability, 0) /
              dirNodes.length
            : 0.5,
        convention_adherence: avgAdherence,
        change_frequency: dirNodes.reduce(
          (s, d) => s + d.metrics.change_frequency,
          0
        ),
        coupling_count: dirNodes.reduce(
          (s, d) => s + d.metrics.coupling_count,
          0
        ),
      },
      entity_count: totalEntities,
      children: dirNodes.sort((a, b) => a.health_score - b.health_score),
    };
  }

  /**
   * Get health data for a single file.
   */
  async getFileHealth(filePath: string): Promise<HealthMapNode | null> {
    const entities = await this.localGraph.getEntitiesByFile(filePath);
    if (entities.length === 0) return null;

    const totalFanIn = entities.reduce((s, e) => s + e.fan_in, 0);
    const totalFanOut = entities.reduce((s, e) => s + e.fan_out, 0);
    const highRiskCount = entities.filter(
      (e) => e.risk_level === "high" || e.risk_level === "critical"
    ).length;

    let couplingCount = 0;
    let changeFrequency = 0;

    if (this.factStore) {
      try {
        const projectFacts = await this.factStore.recallByScope("project", 0.0);
        for (const fact of projectFacts) {
          if (
            fact.subject.startsWith("coupling:") &&
            fact.subject.includes(filePath)
          ) {
            couplingCount++;
          }
        }
        const fileFacts = await this.factStore.recallForFile(filePath);
        changeFrequency = fileFacts.filter(
          (f) => f.fact_type === "episodic"
        ).length;
      } catch {
        // Non-critical
      }
    }

    let conventionAdherence = 0.8;
    try {
      const conventions = await this.localGraph.getConventions();
      if (conventions && conventions.length > 0) {
        conventionAdherence =
          conventions.reduce((s, c) => s + c.adherence_rate, 0) /
          conventions.length /
          100;
      }
    } catch {
      // Non-critical
    }

    const metrics: HealthMetrics = {
      fan_in: totalFanIn,
      fan_out: totalFanOut,
      durability:
        highRiskCount > 0 ? Math.max(0.2, 1 - highRiskCount * 0.15) : 0.8,
      convention_adherence: conventionAdherence,
      change_frequency: changeFrequency,
      coupling_count: couplingCount,
    };

    const healthScore = computeHealthScore(metrics);

    return {
      path: filePath,
      name: filePath.split("/").pop() ?? filePath,
      health_score: Math.round(healthScore * 100) / 100,
      risk_level: scoreToRisk(healthScore),
      metrics,
      entity_count: entities.length,
    };
  }
}
