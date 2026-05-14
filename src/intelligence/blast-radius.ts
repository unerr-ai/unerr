/**
 * Blast Radius Engine — N-hop traversal + risk assessment.
 *
 * N.1: Datalog-style N-hop traversal (1, 2, 3 hops from target entity)
 * N.2: Result assembly (callers, files, communities, risk per hop)
 * N.3: Suggestion generation (risk → human-readable guidance)
 * N.4: File-level blast radius (given file change → affected entities in other files)
 * N.5: Performance optimization (adjacency-list cached traversal, <5ms target)
 *
 * Performance: all queries <5ms on 10K entity graphs via in-memory adjacency.
 */

import type { IndexedEdge, IndexedEntity } from "./indexer/plugin-interface.js";

export interface BlastRadiusEntity {
  key: string;
  name: string;
  kind: string;
  file_path: string;
  risk_level: string;
  community: number;
  hop: number;
}

export interface BlastRadiusResult {
  target: { key: string; name: string; file_path: string };
  hops: Map<number, BlastRadiusEntity[]>;
  totalAffected: number;
  affectedFiles: string[];
  affectedCommunities: number[];
  riskSummary: {
    critical: number;
    high: number;
    medium: number;
    normal: number;
  };
  suggestions: string[];
  resolvedInMs: number;
}

export interface BlastRadiusOptions {
  maxHops?: number;
  maxResults?: number;
}

type AdjacencyIndex = Map<string, Set<string>>;

/**
 * Build a reverse adjacency index (callees → callers) for fast traversal.
 */
export function buildReverseAdjacency(edges: IndexedEdge[]): AdjacencyIndex {
  const adj: AdjacencyIndex = new Map();
  for (const edge of edges) {
    if (edge.type !== "calls") continue;
    if (!adj.has(edge.to_key)) adj.set(edge.to_key, new Set());
    adj.get(edge.to_key)?.add(edge.from_key);
  }
  return adj;
}

/**
 * Compute blast radius via N-hop BFS traversal on the reverse call graph.
 * Returns all entities that transitively depend on the target.
 */
export function computeBlastRadius(
  targetKey: string,
  entities: Map<string, IndexedEntity & { community?: number }>,
  reverseAdj: AdjacencyIndex,
  options: BlastRadiusOptions = {},
): BlastRadiusResult {
  const start = performance.now();
  const maxHops = options.maxHops ?? 3;
  const maxResults = options.maxResults ?? 500;

  const target = entities.get(targetKey);
  const hops = new Map<number, BlastRadiusEntity[]>();
  const visited = new Set<string>([targetKey]);

  let frontier = new Set<string>([targetKey]);

  for (let hop = 1; hop <= maxHops; hop++) {
    const nextFrontier = new Set<string>();
    const hopEntities: BlastRadiusEntity[] = [];

    for (const nodeKey of frontier) {
      const callers = reverseAdj.get(nodeKey);
      if (!callers) continue;

      for (const callerKey of callers) {
        if (visited.has(callerKey)) continue;
        visited.add(callerKey);

        const entity = entities.get(callerKey);
        if (entity) {
          hopEntities.push({
            key: entity.key,
            name: entity.name,
            kind: entity.kind,
            file_path: entity.file_path,
            risk_level:
              (entity as unknown as { risk_level?: string }).risk_level ??
              "normal",
            community:
              (entity as unknown as { community?: number }).community ?? -1,
            hop,
          });
          nextFrontier.add(callerKey);
        }

        if (visited.size > maxResults) break;
      }
      if (visited.size > maxResults) break;
    }

    if (hopEntities.length > 0) {
      hops.set(hop, hopEntities);
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  const allAffected = [...hops.values()].flat();
  const affectedFiles = [...new Set(allAffected.map((e) => e.file_path))];
  const affectedCommunities = [
    ...new Set(allAffected.map((e) => e.community).filter((c) => c >= 0)),
  ];

  const riskSummary = { critical: 0, high: 0, medium: 0, normal: 0 };
  for (const entity of allAffected) {
    const level = entity.risk_level as keyof typeof riskSummary;
    if (level in riskSummary) riskSummary[level]++;
  }

  const suggestions = generateSuggestions(allAffected, riskSummary, target);

  return {
    target: {
      key: targetKey,
      name: target?.name ?? targetKey,
      file_path: target?.file_path ?? "",
    },
    hops,
    totalAffected: allAffected.length,
    affectedFiles,
    affectedCommunities,
    riskSummary,
    suggestions,
    resolvedInMs: performance.now() - start,
  };
}

/**
 * File-level blast radius — given a file path, find all entities in OTHER files
 * that are affected by changes to any entity in the target file.
 */
export function computeFileBlastRadius(
  filePath: string,
  entities: Map<string, IndexedEntity & { community?: number }>,
  reverseAdj: AdjacencyIndex,
  options: BlastRadiusOptions = {},
): BlastRadiusResult {
  const fileEntities = [...entities.values()].filter(
    (e) => e.file_path === filePath,
  );
  if (fileEntities.length === 0) {
    return emptyResult(filePath);
  }

  const start = performance.now();
  const maxHops = options.maxHops ?? 2;
  const visited = new Set<string>(fileEntities.map((e) => e.key));
  const hops = new Map<number, BlastRadiusEntity[]>();

  let frontier = new Set<string>(fileEntities.map((e) => e.key));

  for (let hop = 1; hop <= maxHops; hop++) {
    const nextFrontier = new Set<string>();
    const hopEntities: BlastRadiusEntity[] = [];

    for (const nodeKey of frontier) {
      const callers = reverseAdj.get(nodeKey);
      if (!callers) continue;

      for (const callerKey of callers) {
        if (visited.has(callerKey)) continue;
        visited.add(callerKey);

        const entity = entities.get(callerKey);
        if (entity && entity.file_path !== filePath) {
          hopEntities.push({
            key: entity.key,
            name: entity.name,
            kind: entity.kind,
            file_path: entity.file_path,
            risk_level:
              (entity as unknown as { risk_level?: string }).risk_level ??
              "normal",
            community:
              (entity as unknown as { community?: number }).community ?? -1,
            hop,
          });
          nextFrontier.add(callerKey);
        }
      }
    }

    if (hopEntities.length > 0) hops.set(hop, hopEntities);
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  const allAffected = [...hops.values()].flat();
  const affectedFiles = [...new Set(allAffected.map((e) => e.file_path))];
  const affectedCommunities = [
    ...new Set(allAffected.map((e) => e.community).filter((c) => c >= 0)),
  ];
  const riskSummary = { critical: 0, high: 0, medium: 0, normal: 0 };
  for (const e of allAffected) {
    const level = e.risk_level as keyof typeof riskSummary;
    if (level in riskSummary) riskSummary[level]++;
  }

  return {
    target: { key: filePath, name: filePath, file_path: filePath },
    hops,
    totalAffected: allAffected.length,
    affectedFiles,
    affectedCommunities,
    riskSummary,
    suggestions: generateSuggestions(allAffected, riskSummary, null),
    resolvedInMs: performance.now() - start,
  };
}

function generateSuggestions(
  affected: BlastRadiusEntity[],
  riskSummary: {
    critical: number;
    high: number;
    medium: number;
    normal: number;
  },
  target: (IndexedEntity & { community?: number }) | null | undefined,
): string[] {
  const suggestions: string[] = [];

  if (riskSummary.critical > 0) {
    suggestions.push(
      `${riskSummary.critical} critical entity(ies) affected — consider adding overload/adapter pattern to isolate changes.`,
    );
  }

  if (affected.length > 20) {
    suggestions.push(
      `Wide blast radius (${affected.length} entities). Consider extracting an interface to reduce coupling.`,
    );
  }

  const communities = new Set(
    affected.map((e) => e.community).filter((c) => c >= 0),
  );
  if (communities.size > 2) {
    suggestions.push(
      `Change spans ${communities.size} communities — verify cross-team contracts are maintained.`,
    );
  }

  if (affected.length > 0 && suggestions.length === 0) {
    suggestions.push(
      `${affected.length} dependent(s) affected. Review callers before modifying.`,
    );
  }

  return suggestions;
}

function emptyResult(target: string): BlastRadiusResult {
  return {
    target: { key: target, name: target, file_path: target },
    hops: new Map(),
    totalAffected: 0,
    affectedFiles: [],
    affectedCommunities: [],
    riskSummary: { critical: 0, high: 0, medium: 0, normal: 0 },
    suggestions: [],
    resolvedInMs: 0,
  };
}
