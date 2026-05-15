/**
 * Enhanced Health Grading — 5-factor composite score → A-F grade.
 *
 * O.1: Circular dependency detection (Tarjan's SCC on call graph)
 * O.2: Fan-in distribution analysis (skew detection)
 * O.3: Import depth measurement (longest chain)
 * O.4: Test coverage proxy (test file ratio)
 * O.5: Composite health grade (weighted score)
 *
 * Factors (100 points each, weighted):
 *   1. Circular dependencies (30%): 0 cycles = 100, each cycle -15
 *   2. Fan-in distribution (20%): low skew = 100, high skew (few hubs) -
 *   3. Import depth (15%): shallow chains = 100, deep (>8) penalized
 *   4. Test coverage proxy (20%): test_files/source_files ratio
 *   5. Community cohesion (15%): avg cohesion across communities
 */

import type { IndexedEdge, IndexedEntity } from "./indexer/plugin-interface.js";
import { isTestFile } from "./indexer/test-detector.js";

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export interface HealthFactor {
  name: string;
  score: number;
  weight: number;
  details: string;
}

export interface HealthReport {
  grade: HealthGrade;
  score: number;
  factors: HealthFactor[];
  circularDeps: Array<{ cycle: string[]; severity: string }>;
  entityCount: number;
  edgeCount: number;
}

/**
 * Detect circular dependencies using DFS-based cycle detection.
 */
export function detectCircularDeps(edges: IndexedEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "calls" && edge.type !== "imports") continue;
    if (!adj.has(edge.from_key)) adj.set(edge.from_key, []);
    adj.get(edge.from_key)?.push(edge.to_key);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (cycles.length >= 10) return;
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        const cycleStart = stack.indexOf(neighbor);
        if (cycleStart >= 0) {
          cycles.push(stack.slice(cycleStart));
        }
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Analyze fan-in distribution (Gini coefficient of caller counts).
 */
export function analyzeFanInDistribution(edges: IndexedEdge[]): {
  giniCoefficient: number;
  maxFanIn: number;
  avgFanIn: number;
} {
  const fanIn = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type === "calls") {
      fanIn.set(edge.to_key, (fanIn.get(edge.to_key) ?? 0) + 1);
    }
  }

  const values = [...fanIn.values()].sort((a, b) => a - b);
  if (values.length === 0)
    return { giniCoefficient: 0, maxFanIn: 0, avgFanIn: 0 };

  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / n;

  let numerator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      numerator += Math.abs(values[i]! - values[j]!);
    }
  }

  const gini = n > 1 ? numerator / (2 * n * sum || 1) : 0;
  return {
    giniCoefficient: Math.min(1, gini),
    maxFanIn: values[n - 1] ?? 0,
    avgFanIn: avg,
  };
}

/**
 * Measure maximum import depth (longest dependency chain).
 */
export function measureImportDepth(edges: IndexedEdge[]): number {
  const importEdges = edges.filter(
    (e) => e.type === "imports" || e.type === "calls"
  );
  const adj = new Map<string, string[]>();
  for (const edge of importEdges) {
    if (!adj.has(edge.from_key)) adj.set(edge.from_key, []);
    adj.get(edge.from_key)?.push(edge.to_key);
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(node: string): number {
    if (memo.has(node)) return memo.get(node)!;
    if (visiting.has(node)) return 0;
    visiting.add(node);

    let maxChild = 0;
    for (const child of adj.get(node) ?? []) {
      maxChild = Math.max(maxChild, depth(child) + 1);
    }

    visiting.delete(node);
    memo.set(node, maxChild);
    return maxChild;
  }

  let maxDepth = 0;
  for (const node of adj.keys()) {
    maxDepth = Math.max(maxDepth, depth(node));
  }

  return maxDepth;
}

/**
 * Compute test coverage proxy from file paths.
 */
export function computeTestCoverageProxy(entities: IndexedEntity[]): number {
  const files = new Set(entities.map((e) => e.file_path));
  const testFileSet = [...files].filter((f) => isTestFile(f));
  const sourceFiles = [...files].filter((f) => !isTestFile(f));
  if (sourceFiles.length === 0) return 1.0;
  return Math.min(1.0, testFileSet.length / sourceFiles.length);
}

/**
 * Compute the composite health grade from all factors.
 */
export function computeHealthGrade(
  entities: IndexedEntity[],
  edges: IndexedEdge[],
  communityCohesion = 0.5
): HealthReport {
  const cycles = detectCircularDeps(edges);
  const cycleScore = Math.max(0, 100 - cycles.length * 15);

  const fanInAnalysis = analyzeFanInDistribution(edges);
  const fanInScore = Math.max(0, 100 - fanInAnalysis.giniCoefficient * 80);

  const importDepth = measureImportDepth(edges);
  const depthScore =
    importDepth <= 5 ? 100 : Math.max(0, 100 - (importDepth - 5) * 10);

  const testRatio = computeTestCoverageProxy(entities);
  const testScore = Math.min(100, testRatio * 100);

  const cohesionScore = communityCohesion * 100;

  const factors: HealthFactor[] = [
    {
      name: "Circular Dependencies",
      score: cycleScore,
      weight: 0.3,
      details: `${cycles.length} cycle(s) detected`,
    },
    {
      name: "Fan-in Distribution",
      score: fanInScore,
      weight: 0.2,
      details: `Gini: ${fanInAnalysis.giniCoefficient.toFixed(2)}, max: ${fanInAnalysis.maxFanIn}`,
    },
    {
      name: "Import Depth",
      score: depthScore,
      weight: 0.15,
      details: `Max depth: ${importDepth}`,
    },
    {
      name: "Test Coverage Proxy",
      score: testScore,
      weight: 0.2,
      details: `Ratio: ${(testRatio * 100).toFixed(0)}%`,
    },
    {
      name: "Community Cohesion",
      score: cohesionScore,
      weight: 0.15,
      details: `Avg cohesion: ${communityCohesion.toFixed(2)}`,
    },
  ];

  const compositeScore = factors.reduce(
    (sum, f) => sum + f.score * f.weight,
    0
  );

  const grade: HealthGrade =
    compositeScore >= 85
      ? "A"
      : compositeScore >= 70
        ? "B"
        : compositeScore >= 55
          ? "C"
          : compositeScore >= 40
            ? "D"
            : "F";

  return {
    grade,
    score: Math.round(compositeScore),
    factors,
    circularDeps: cycles.map((c) => ({
      cycle: c,
      severity: c.length > 3 ? "high" : "medium",
    })),
    entityCount: entities.length,
    edgeCount: edges.length,
  };
}
