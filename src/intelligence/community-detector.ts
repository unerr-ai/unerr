/**
 * Community Detection — Louvain clustering + profile computation + name inference.
 *
 * M.1: Runs Louvain community detection via graphology on the entity graph.
 * M.2: Computes per-community profiles (cohesion, coupling, dominant kinds).
 * M.3: Infers community names from file paths + entity names.
 * M.6: Recomputation trigger (>10% entity change threshold).
 *
 * Performance: runs once per full index, cached. Recomputed only when
 * entity count changes by >10% from last computation.
 */

import { createModuleLogger } from "../utils/logger.js";
import type { IndexedEdge, IndexedEntity } from "./indexer/plugin-interface.js";

const log = createModuleLogger("community-detector");

export interface CommunityProfile {
  id: number;
  name: string;
  entityCount: number;
  entityKeys: string[];
  dominantKinds: Array<{ kind: string; count: number }>;
  files: string[];
  cohesion: number;
  coupling: number;
}

export interface CommunityResult {
  communities: CommunityProfile[];
  assignments: Map<string, number>;
  modularity: number;
  entityCount: number;
  computedAt: string;
}

let lastEntityCount = 0;
let cachedResult: CommunityResult | null = null;

const RECOMPUTE_THRESHOLD = 0.1;

/**
 * Check if community detection needs recomputation.
 */
export function needsRecomputation(currentEntityCount: number): boolean {
  if (!cachedResult) return true;
  if (lastEntityCount === 0) return true;
  const changeRatio =
    Math.abs(currentEntityCount - lastEntityCount) / lastEntityCount;
  return changeRatio > RECOMPUTE_THRESHOLD;
}

/**
 * Run Louvain community detection on the entity graph.
 */
export async function detectCommunities(
  entities: IndexedEntity[],
  edges: IndexedEdge[]
): Promise<CommunityResult> {
  if (!needsRecomputation(entities.length) && cachedResult) {
    return cachedResult;
  }

  const start = performance.now();

  const graphologyMod = (await import("graphology")) as any;
  const Graph = graphologyMod.default ?? graphologyMod;
  const louvainMod = (await import("graphology-communities-louvain")) as any;
  const louvain = louvainMod.default ?? louvainMod;

  const graph = new Graph({ type: "undirected", allowSelfLoops: false });

  for (const entity of entities) {
    if (!graph.hasNode(entity.key)) {
      graph.addNode(entity.key, {
        kind: entity.kind,
        name: entity.name,
        file_path: entity.file_path,
      });
    }
  }

  const entityKeys = new Set(entities.map((e) => e.key));
  for (const edge of edges) {
    if (
      entityKeys.has(edge.from_key) &&
      entityKeys.has(edge.to_key) &&
      edge.from_key !== edge.to_key &&
      !graph.hasEdge(edge.from_key, edge.to_key)
    ) {
      try {
        graph.addEdge(edge.from_key, edge.to_key);
      } catch {
        /* edge already exists or invalid — skip */
      }
    }
  }

  if (graph.order === 0) {
    const empty: CommunityResult = {
      communities: [],
      assignments: new Map(),
      modularity: 0,
      entityCount: 0,
      computedAt: new Date().toISOString(),
    };
    cachedResult = empty;
    lastEntityCount = 0;
    return empty;
  }

  const assignments = louvain(graph);
  const modularity = louvain.assign(graph);

  const communityMap = new Map<number, string[]>();
  for (const [nodeKey, communityId] of Object.entries(assignments)) {
    const cid = communityId as number;
    if (!communityMap.has(cid)) communityMap.set(cid, []);
    communityMap.get(cid)?.push(nodeKey);
  }

  const profiles: CommunityProfile[] = [];
  const assignmentMap = new Map<string, number>();

  for (const [communityId, memberKeys] of communityMap) {
    for (const key of memberKeys) {
      assignmentMap.set(key, communityId);
    }

    const memberEntities = entities.filter((e) => memberKeys.includes(e.key));

    const kindCounts = new Map<string, number>();
    const fileSet = new Set<string>();
    for (const e of memberEntities) {
      kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);
      fileSet.add(e.file_path);
    }

    const dominantKinds = [...kindCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kind, count]) => ({ kind, count }));

    const internalEdges = edges.filter(
      (e) => memberKeys.includes(e.from_key) && memberKeys.includes(e.to_key)
    ).length;
    const externalEdges = edges.filter(
      (e) =>
        (memberKeys.includes(e.from_key) && !memberKeys.includes(e.to_key)) ||
        (!memberKeys.includes(e.from_key) && memberKeys.includes(e.to_key))
    ).length;

    const totalPossibleInternal =
      (memberKeys.length * (memberKeys.length - 1)) / 2;
    const cohesion =
      totalPossibleInternal > 0 ? internalEdges / totalPossibleInternal : 0;
    const coupling =
      internalEdges + externalEdges > 0
        ? externalEdges / (internalEdges + externalEdges)
        : 0;

    const name = inferCommunityName(
      [...fileSet],
      memberEntities.map((e) => e.name)
    );

    profiles.push({
      id: communityId,
      name,
      entityCount: memberKeys.length,
      entityKeys: memberKeys,
      dominantKinds,
      files: [...fileSet],
      cohesion: Math.round(cohesion * 1000) / 1000,
      coupling: Math.round(coupling * 1000) / 1000,
    });
  }

  profiles.sort((a, b) => b.entityCount - a.entityCount);

  const result: CommunityResult = {
    communities: profiles,
    assignments: assignmentMap,
    modularity: typeof modularity === "number" ? modularity : 0,
    entityCount: entities.length,
    computedAt: new Date().toISOString(),
  };

  cachedResult = result;
  lastEntityCount = entities.length;

  log.info(
    `Detected ${profiles.length} communities in ${Math.round(performance.now() - start)}ms (modularity: ${result.modularity.toFixed(3)})`
  );

  return result;
}

/**
 * Infer a human-readable community name from file paths + entity names.
 */
function inferCommunityName(files: string[], names: string[]): string {
  const dirFreq = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    for (const part of parts.slice(0, -1)) {
      if (!["src", "lib", "app", "index"].includes(part)) {
        dirFreq.set(part, (dirFreq.get(part) ?? 0) + 1);
      }
    }
  }

  if (dirFreq.size > 0) {
    const topDir = [...dirFreq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topDir && topDir[1] >= files.length * 0.3) {
      return topDir[0];
    }
  }

  const nameFreq = new Map<string, number>();
  for (const name of names) {
    const tokens = name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_-]+/);
    for (const token of tokens) {
      if (token.length > 2) nameFreq.set(token, (nameFreq.get(token) ?? 0) + 1);
    }
  }

  if (nameFreq.size > 0) {
    const topToken = [...nameFreq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topToken) return topToken[0];
  }

  return `community-${files.length}`;
}

/**
 * Get cached result (or null if not computed).
 */
export function getCachedCommunities(): CommunityResult | null {
  return cachedResult;
}

/**
 * Clear cache (for testing).
 */
export function clearCommunityCache(): void {
  cachedResult = null;
  lastEntityCount = 0;
}
