/**
 * First-Contact Health Grade — surfaces architectural anti-patterns in 60 seconds.
 *
 * After setup wizard triggers indexing, this module polls for graph snapshot
 * availability, loads into CozoDB, and queries for:
 *   1. Dead functions (fan_in=0, excluding entry points)
 *   2. Highest-risk entities (top 3 by fan_in + fan_out)
 *   3. Total entities / edges / rules for context
 *
 * Prints a health grade card to stderr. The PLG acquisition hook.
 */

import type { CozoDb } from "./cozo-schema.js";
import { isTestFile } from "./indexer/test-detector.js";

export interface HealthGradeResult {
  grade: string;
  totalEntities: number;
  totalEdges: number;
  totalRules: number;
  deadFunctionCount: number;
  highRiskEntities: Array<{
    name: string;
    kind: string;
    file_path: string;
    fan_in: number;
    fan_out: number;
  }>;
  score: number;
  /** Sprint 3.3: Circular dependency cycles detected. */
  circularDeps?: Array<{ cycle: string[] }>;
  /** Sprint 3.3: Longest import chain depth in the graph. */
  maxImportDepth?: number;
  /** Sprint 3.3: Convention adherence rate (0-1). */
  conventionAdherence?: number;
  /** Sprint 3.3: Drift impact — drifted entities in high-fan-in zones. */
  driftImpactScore?: number;
  /** Test files with no "tests" edges — not associated with any source entity. */
  orphanTestFiles?: Array<{ file: string; reason: string }>;
}

/** Entry point names excluded from "dead function" detection. */
const ENTRY_POINT_PATTERNS = [
  "main",
  "index",
  "app",
  "server",
  "bootstrap",
  "configure",
  "setup",
  "init",
  "run",
  "start",
  "default",
  "register",
  "create",
  "make",
  "build",
  "get",
  "use",
];

const HANDLER_SUFFIXES = [
  "Handler",
  "handler",
  "Controller",
  "controller",
  "Middleware",
  "middleware",
  "Route",
  "route",
  "Action",
  "action",
  "Callback",
  "callback",
  "Listener",
  "listener",
  "Resolver",
  "resolver",
  "Factory",
  "factory",
  "Provider",
  "provider",
  "Hook",
  "hook",
  "Plugin",
  "plugin",
  "Command",
  "command",
  "Adapter",
  "adapter",
];

/** Patterns that indicate a function is part of a framework lifecycle (not dead). */
const FRAMEWORK_PATTERNS = [
  // React
  /^use[A-Z]/, // hooks: useEffect, useState, useCustomHook
  /^render/, // render methods
  /^on[A-Z]/, // event handlers: onClick, onChange
  /^handle[A-Z]/, // event handlers: handleClick, handleSubmit
  // Express/Hono/Fastify
  /^(get|post|put|patch|delete|head|options)$/i,
  // Lifecycle
  /^(before|after|on)(Each|All|Mount|Unmount|Create|Destroy|Init|Close|Load|Ready)/,
  // Exports (common patterns)
  /^(export|define|provide|inject|connect|subscribe|dispatch|emit)/,
  // CLI
  /^(action|command|program)/,
  // Testing
  /^(describe|it|expect|assert|should|before|after|vi|jest)/,
];

/**
 * Compute health grade from a loaded CozoDB instance.
 */
export async function computeHealthGrade(
  db: CozoDb,
): Promise<HealthGradeResult> {
  // Total entity count
  let totalEntities = 0;
  let totalEdges = 0;
  let totalRules = 0;
  let deadFunctionCount = 0;
  let highRiskEntities: Array<{
    name: string;
    kind: string;
    file_path: string;
    fan_in: number;
    fan_out: number;
  }> = [];

  try {
    const entityResult = await db.run("?[count(key)] := *entities{key}");
    totalEntities = (entityResult?.rows?.[0]?.[0] as number) ?? 0;
  } catch {
    // Empty or uninitialized graph
  }

  try {
    const edgeResult = await db.run("?[count(from_key)] := *edges{from_key}");
    totalEdges = (edgeResult?.rows?.[0]?.[0] as number) ?? 0;
  } catch {
    // Empty or uninitialized graph
  }

  try {
    const ruleResult = await db.run("?[count(key)] := *rules{key}");
    totalRules = (ruleResult?.rows?.[0]?.[0] as number) ?? 0;
  } catch {
    // Empty or uninitialized graph
  }

  // Dead functions: fan_in=0, fan_out=0, kind=function, not entry points/framework patterns
  // A truly dead function has NO callers AND calls nothing (isolated).
  // fan_in=0 alone is too aggressive — exported functions, hooks, handlers all have fan_in=0
  // because static analysis can't capture dynamic/framework-mediated calls.
  try {
    const allFunctions = await db.run(
      `?[key, name, fp, fan_in, fan_out] := *entities{key, kind, name, file_path: fp, fan_in, fan_out}, kind = "function", fan_in == 0`,
    );
    const deadFunctions = (allFunctions?.rows ?? []).filter((row) => {
      const name = row[1] as string;
      const filePath = row[2] as string;
      const fanOut = row[4] as number;
      const nameLower = name.toLowerCase();

      // Functions with fan_out > 0 are likely real (they call other things, just aren't
      // called via edges we can track — e.g. exported API, CLI commands, handlers)
      if (fanOut > 2) return false;

      // Exclude test files entirely �� test functions are called by test runners
      if (isTestFile(filePath)) return false;

      // Exclude entry points
      if (
        ENTRY_POINT_PATTERNS.some(
          (p) => nameLower === p || nameLower.startsWith(p),
        )
      )
        return false;
      // Exclude handlers/suffixes
      if (HANDLER_SUFFIXES.some((s) => name.endsWith(s))) return false;
      // Exclude framework patterns
      if (FRAMEWORK_PATTERNS.some((p) => p.test(name))) return false;
      // Exclude test functions
      if (
        nameLower.startsWith("test") ||
        nameLower.includes("spec") ||
        nameLower.includes("mock") ||
        nameLower.includes("stub") ||
        nameLower.includes("fixture")
      )
        return false;
      // Exclude single-letter or very short names (likely params/lambdas misclassified)
      if (name.length <= 2) return false;
      return true;
    });
    deadFunctionCount = deadFunctions.length;
  } catch {
    // Query failed — treat as 0 dead functions
  }

  // High-risk entities: top 3 by total blast radius (fan_in + fan_out)
  try {
    const highRiskResult = await db.run(
      `?[key, kind, name, fp, fan_in, fan_out, risk_level] :=
        *entities{key, kind, name, file_path: fp, fan_in, fan_out, risk_level},
        risk_level == "high"
      :order -(fan_in + fan_out)
      :limit 3`,
    );
    highRiskEntities = (highRiskResult?.rows ?? []).map((row) => ({
      name: row[2] as string,
      kind: row[1] as string,
      file_path: row[3] as string,
      fan_in: row[4] as number,
      fan_out: row[5] as number,
    }));
  } catch {
    // Query failed — no high risk entities
  }

  // Sprint 3.3: Circular dependency detection via CozoDB cycle query
  const circularDeps = await detectCircularDeps(db);

  // Sprint 3.3: Longest import chain depth
  const maxImportDepth = await computeMaxImportDepth(db);

  // Sprint 3.3: Convention adherence rate
  const conventionAdherence = await computeConventionAdherence(
    db,
    totalEntities,
  );

  // Sprint 3.3: Drift impact score
  const driftImpactScore = await computeDriftImpact(db);

  // Orphan test files: test files with no outbound "tests" edges
  const orphanTestFiles = await detectOrphanTestFiles(db);

  // Compute score (0-100) with new signals
  const score = computeScore(
    totalEntities,
    deadFunctionCount,
    highRiskEntities.length,
    totalRules,
    circularDeps.length,
    maxImportDepth,
    conventionAdherence,
    driftImpactScore,
  );
  const grade = scoreToGrade(score);

  return {
    grade,
    totalEntities,
    totalEdges,
    totalRules,
    deadFunctionCount,
    highRiskEntities,
    score,
    circularDeps: circularDeps.length > 0 ? circularDeps : undefined,
    maxImportDepth,
    conventionAdherence,
    driftImpactScore: driftImpactScore > 0 ? driftImpactScore : undefined,
    orphanTestFiles: orphanTestFiles.length > 0 ? orphanTestFiles : undefined,
  };
}

function computeScore(
  totalEntities: number,
  deadFunctions: number,
  highRiskCount: number,
  ruleCount: number,
  circularDepCount = 0,
  maxImportDepth = 0,
  conventionAdherence = 1,
  driftImpact = 0,
): number {
  if (totalEntities === 0) return 50; // Empty repo, neutral

  let score = 80; // Start at B

  // Dead function ratio penalty (max -30 points)
  const deadRatio = deadFunctions / totalEntities;
  if (deadRatio > 0.3) score -= 30;
  else if (deadRatio > 0.2) score -= 20;
  else if (deadRatio > 0.1) score -= 10;
  else if (deadRatio > 0.05) score -= 5;

  // High-risk entities penalty (max -20 points)
  score -= Math.min(highRiskCount * 7, 20);

  // Rules bonus (+10 if any rules exist)
  if (ruleCount > 0) score += 10;

  // Small codebase bonus (+5 for <100 entities)
  if (totalEntities < 100) score += 5;

  // Sprint 3.3: Circular dependency penalty (max -15 points)
  if (circularDepCount > 5) score -= 15;
  else if (circularDepCount > 2) score -= 10;
  else if (circularDepCount > 0) score -= 5;

  // Sprint 3.3: Import chain depth penalty (max -10 points)
  if (maxImportDepth > 15) score -= 10;
  else if (maxImportDepth > 10) score -= 7;
  else if (maxImportDepth > 7) score -= 3;

  // Sprint 3.3: Convention adherence bonus (max +10 points)
  if (conventionAdherence >= 0.9) score += 10;
  else if (conventionAdherence >= 0.7) score += 5;
  else if (conventionAdherence < 0.5) score -= 5;

  // Sprint 3.3: Drift impact penalty (max -10 points)
  if (driftImpact > 10) score -= 10;
  else if (driftImpact > 5) score -= 7;
  else if (driftImpact > 0) score -= 3;

  return Math.max(0, Math.min(100, score));
}

/**
 * Sprint 3.3: Detect circular dependencies using CozoDB cycle detection.
 * Uses recursive Datalog to find paths from A back to A via "calls" edges.
 * Returns up to 10 cycles (capped for performance).
 */
async function detectCircularDeps(
  db: CozoDb,
): Promise<Array<{ cycle: string[] }>> {
  try {
    // Find entities that can reach themselves through "calls" edges (cycle detection)
    // Use named rule for recursion, then filter for self-reachable entities
    const result = await db.run(
      `reach[start, next] := *edges{from_key: start, to_key: next, type: "calls"}
       reach[start, next] := reach[start, mid], *edges{from_key: mid, to_key: next, type: "calls"}
       ?[key] := reach[key, key]
       :limit 10`,
    );
    return result.rows.map((row) => ({ cycle: [row[0] as string] }));
  } catch {
    // CozoDB may not support this query form — graceful fallback
    // Use simpler 2-hop cycle detection
    try {
      const result = await db.run(
        `?[a, b] := *edges{from_key: a, to_key: b, type: "calls"}, *edges{from_key: b, to_key: a, type: "calls"}
         :limit 10`,
      );
      return result.rows.map((row) => ({
        cycle: [row[0] as string, row[1] as string],
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Sprint 3.3: Compute longest import chain depth using recursive Datalog.
 * Finds the maximum depth of the call graph from any root.
 */
async function computeMaxImportDepth(db: CozoDb): Promise<number> {
  try {
    const result = await db.run(
      `reach[target, depth] := *edges{from_key, to_key: target, type: "calls"}, depth = 1
       reach[target, depth] := reach[mid, d], *edges{from_key: mid, to_key: target, type: "calls"}, depth = d + 1, d < 20
       ?[max(depth)] := reach[_, depth]`,
    );
    return (result.rows[0]?.[0] as number) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Sprint 3.3: Compute convention adherence rate from patterns.
 * Returns ratio of entities following detected naming patterns (0-1).
 */
async function computeConventionAdherence(
  db: CozoDb,
  totalEntities: number,
): Promise<number> {
  if (totalEntities === 0) return 1;
  try {
    const patterns = await db.run(
      "?[freq] := *patterns[_, _, kind, freq, conf, _, _], kind = 'naming', conf > 0.7",
    );
    if (patterns.rows.length === 0) return 1; // No patterns = 100% adherence by default
    const totalFollowing = patterns.rows.reduce(
      (sum, row) => sum + (row[0] as number),
      0,
    );
    return Math.min(1, totalFollowing / totalEntities);
  } catch {
    return 1;
  }
}

/**
 * Sprint 3.3: Compute drift impact score.
 * Counts drifted entities that are in high-fan-in zones (fan_in > 5).
 */
async function computeDriftImpact(db: CozoDb): Promise<number> {
  try {
    const result = await db.run(
      `?[count(dk)] := *drift_overlay{key: dk},
        *entities{key: dk, fan_in: fi}, fi > 5`,
    );
    return (result.rows[0]?.[0] as number) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Detect orphan test files — test files whose entities have no outbound "tests" edges.
 * These are test files not associated with any source entity in the graph.
 */
async function detectOrphanTestFiles(
  db: CozoDb,
): Promise<Array<{ file: string; reason: string }>> {
  try {
    // Get all test files (files containing is_test=true entities)
    const testFilesResult = await db.run(
      `?[fp] := *entities{file_path: fp, is_test: t}, t = true`,
    );
    const allTestFiles = new Set(
      testFilesResult.rows.map((row) => row[0] as string),
    );

    if (allTestFiles.size === 0) return [];

    // Get test files that have at least one "tests" edge from any of their entities
    const coveredResult = await db.run(
      `?[fp] := *entities{key: ek, file_path: fp, is_test: t}, t = true,
        *edges{from_key: ek, type: "tests"}`,
    );
    const coveredFiles = new Set(
      coveredResult.rows.map((row) => row[0] as string),
    );

    // Orphans = test files NOT in the covered set
    const orphans: Array<{ file: string; reason: string }> = [];
    for (const file of allTestFiles) {
      if (!coveredFiles.has(file)) {
        orphans.push({
          file,
          reason: "no source imports detected",
        });
      }
    }

    return orphans.sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    return [];
  }
}

function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B+";
  if (score >= 70) return "B";
  if (score >= 60) return "C+";
  if (score >= 50) return "C";
  if (score >= 40) return "D";
  return "F";
}

/**
 * Format health grade card for terminal output.
 */
export function formatHealthGrade(result: HealthGradeResult): string {
  const lines: string[] = [
    "",
    "── Health Grade ────────────────────────────────",
    `  Grade:          ${result.grade} (${result.score}/100)`,
    `  Entities:       ${result.totalEntities} (${result.totalEdges} edges)`,
    `  Rules:          ${result.totalRules}`,
    `  Dead functions: ${result.deadFunctionCount}`,
  ];

  if (result.highRiskEntities.length > 0) {
    lines.push("  High-risk:");
    for (const entity of result.highRiskEntities) {
      lines.push(
        `    - ${entity.name} (${entity.kind}) — ${entity.fan_in} callers, ${entity.fan_out} callees`,
      );
      lines.push(`      ${entity.file_path}`);
    }
  } else {
    lines.push("  High-risk:      None detected");
  }

  if (result.circularDeps && result.circularDeps.length > 0) {
    lines.push(
      `  Circular deps:  ${result.circularDeps.length} cycle(s) detected`,
    );
  }
  if (result.maxImportDepth !== undefined && result.maxImportDepth > 0) {
    lines.push(`  Import depth:   ${result.maxImportDepth} (longest chain)`);
  }
  if (result.conventionAdherence !== undefined) {
    lines.push(
      `  Conventions:    ${Math.round(result.conventionAdherence * 100)}% adherence`,
    );
  }
  if (result.driftImpactScore !== undefined && result.driftImpactScore > 0) {
    lines.push(
      `  Drift impact:   ${result.driftImpactScore} high-fan-in entities drifted`,
    );
  }

  if (result.orphanTestFiles && result.orphanTestFiles.length > 0) {
    lines.push(
      `  Orphan tests:   ${result.orphanTestFiles.length} test file(s) not linked to source`,
    );
    for (const orphan of result.orphanTestFiles.slice(0, 5)) {
      lines.push(`    - ${orphan.file}`);
    }
    if (result.orphanTestFiles.length > 5) {
      lines.push(`    ... and ${result.orphanTestFiles.length - 5} more`);
    }
  }

  lines.push("───────────────────────────────────────────────");
  lines.push("");

  return lines.join("\n");
}
