/**
 * Multi-Level Cascaded Community Detection via Louvain Algorithm.
 *
 * Implements a hierarchically-consistent two-phase community detection:
 *   Phase 1 — File macro-communities from weighted file edges + directory proximity + class hierarchy
 *   Phase 2 — Entity sub-communities within each macro-community (scoped Louvain)
 *   Phase 3 — Consistency validation + isolate assignment
 *
 * Hierarchical IDs: entity.community = macro_id * 1000 + local_sub_id
 * This ensures: floor(entity.community / 1000) === file's macro-community for ALL entities.
 *
 * Performance: Phase 1 <5ms (file nodes only), Phase 2 <150ms (scoped sub-runs).
 * Replaces per-request computation with one-time indexing materialization.
 */

import { dirname } from "node:path";
// NodeNext CJS interop: graphology and graphology-communities-louvain ship as CJS
// with .d.ts using `export default`. TypeScript NodeNext sees the module namespace
// instead of the default export. We define the minimal interface we use and cast.
import GraphNs from "graphology";
import louvainNs from "graphology-communities-louvain";
import { isTestFile } from "./indexer/test-detector.js";

interface GraphLike {
  addNode(key: string, attributes?: Record<string, unknown>): void;
  addEdge(
    source: string,
    target: string,
    attributes?: Record<string, unknown>
  ): void;
  hasNode(key: string): boolean;
  hasEdge(source: string, target: string): boolean;
  degree(node: string): number;
  size: number;
  order: number;
  forEachNode(
    callback: (node: string, attributes: Record<string, unknown>) => void
  ): void;
  forEachEdge(
    node: string,
    callback: (
      edge: string,
      attributes: unknown,
      source: string,
      target: string
    ) => void
  ): void;
  getNodeAttributes(node: string): Record<string, unknown>;
  getEdgeAttributes(edge: string): Record<string, unknown>;
}

interface GraphConstructor {
  new (opts: { type: string; allowSelfLoops: boolean }): GraphLike;
}

type LouvainFn = (
  graph: GraphLike,
  options?: {
    resolution?: number;
    getEdgeWeight?:
      | string
      | ((edge: string, attrs: Record<string, unknown>) => number);
  }
) => Record<string, number>;

const Graph = GraphNs as unknown as GraphConstructor;
const louvain = louvainNs as unknown as LouvainFn;

// ── Public Types ────────────────────────────────────────────────

export interface CommunityInfo {
  id: number;
  label: string;
  size: number;
  cohesion: number;
}

export interface FileCommunityAssignment {
  file_path: string;
  community: number;
  label: string;
  cohesion: number;
}

export interface CascadedCommunityResult {
  /** Entity key → hierarchical community ID (macro * 1000 + local) */
  entityAssignments: Map<string, number>;
  /** File-level macro-community assignments */
  fileCommunities: FileCommunityAssignment[];
  /** Macro-community metadata (stored in `communities` relation) */
  macroCommunities: CommunityInfo[];
}

// ── Input Types ─────────────────────────────────────────────────

interface FileEdgeInput {
  from_file: string;
  to_file: string;
  edge_type: string;
  weight: number;
}

interface EntityInput {
  key: string;
  kind: string;
  file_path: string;
}

interface EntityEdgeInput {
  from_key: string;
  to_key: string;
  type: string;
}

// ── Main Entry Point ────────────────────────────────────────────

/**
 * Cascaded multi-level community detection.
 *
 * Phase 1: Build file graph from weighted file edges + synthetic signals → Louvain → file macro-communities
 * Phase 2: For each macro-community, run scoped Louvain on entity subgraph → sub-communities
 * Phase 3: Validate hierarchical consistency + assign isolates
 */
export function detectCascadedCommunities(
  fileEdges: FileEdgeInput[],
  entities: EntityInput[],
  entityEdges: EntityEdgeInput[]
): CascadedCommunityResult {
  if (entities.length === 0) {
    return {
      entityAssignments: new Map(),
      fileCommunities: [],
      macroCommunities: [],
    };
  }

  // Collect unique file paths
  const allFiles = new Set<string>();
  for (const e of entities) {
    if (e.file_path) allFiles.add(e.file_path);
  }

  if (allFiles.size === 0) {
    return {
      entityAssignments: new Map(),
      fileCommunities: [],
      macroCommunities: [],
    };
  }

  // ── Phase 1: File Macro-Communities ─────────────────────────────

  const fileGraph = new Graph({ type: "undirected", allowSelfLoops: false });

  for (const fp of allFiles) {
    fileGraph.addNode(fp, { is_test: isTestFile(fp) });
  }

  // Pre-aggregate file edge weights across edge types (calls + imports + tests + implements)
  const aggregatedWeights = new Map<string, number>();
  for (const fe of fileEdges) {
    if (!allFiles.has(fe.from_file) || !allFiles.has(fe.to_file)) continue;
    if (fe.from_file === fe.to_file) continue;

    let weight = fe.weight;
    if (
      fe.edge_type === "tests" ||
      (isTestFile(fe.from_file) && !isTestFile(fe.to_file))
    ) {
      weight *= 3;
    }

    // Normalize undirected pair key (smaller path first)
    const [a, b] =
      fe.from_file < fe.to_file
        ? [fe.from_file, fe.to_file]
        : [fe.to_file, fe.from_file];
    const pairKey = `${a}\0${b}`;
    aggregatedWeights.set(
      pairKey,
      (aggregatedWeights.get(pairKey) ?? 0) + weight
    );
  }

  // Add aggregated file edges to graph
  for (const [pairKey, weight] of aggregatedWeights) {
    const [a, b] = pairKey.split("\0") as [string, string];
    try {
      fileGraph.addEdge(a, b, { weight });
    } catch {
      // parallel edge
    }
  }

  // Directory proximity synthetic edges: files in same directory get weight 0.5
  const dirToFiles = new Map<string, string[]>();
  for (const fp of allFiles) {
    const dir = dirname(fp);
    let files = dirToFiles.get(dir);
    if (!files) {
      files = [];
      dirToFiles.set(dir, files);
    }
    files.push(fp);
  }

  for (const [, files] of dirToFiles) {
    if (files.length < 2) continue;
    // Connect files in same directory with proximity signal (limited to avoid O(n²))
    const limit = Math.min(files.length, 20);
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        const a = files[i]!;
        const b = files[j]!;
        if (!fileGraph.hasEdge(a, b)) {
          try {
            fileGraph.addEdge(a, b, { weight: 0.5 });
          } catch {
            // parallel edge
          }
        }
      }
    }
  }

  // Class hierarchy bonus: files sharing implements/extends get weight 2.0
  // (Detected from entity edges of type "implements" or "extends" across files)
  const classHierarchyFiles = new Set<string>();
  for (const edge of entityEdges) {
    if (edge.type !== "implements" && edge.type !== "extends") continue;
    const fromEntity = entities.find((e) => e.key === edge.from_key);
    const toEntity = entities.find((e) => e.key === edge.to_key);
    if (
      fromEntity &&
      toEntity &&
      fromEntity.file_path !== toEntity.file_path &&
      allFiles.has(fromEntity.file_path) &&
      allFiles.has(toEntity.file_path)
    ) {
      const pair = `${fromEntity.file_path}|${toEntity.file_path}`;
      if (!classHierarchyFiles.has(pair)) {
        classHierarchyFiles.add(pair);
        if (!fileGraph.hasEdge(fromEntity.file_path, toEntity.file_path)) {
          try {
            fileGraph.addEdge(fromEntity.file_path, toEntity.file_path, {
              weight: 2.0,
            });
          } catch {
            // parallel edge
          }
        }
      }
    }
  }

  // Run Louvain on file graph
  let filePartition: Record<string, number> = {};
  const fileAssignments = new Map<string, number>();

  if (fileGraph.size > 0) {
    // At least one edge exists
    filePartition = louvain(fileGraph, {
      resolution: 1.2,
      getEdgeWeight: "weight",
    });

    // Remap to contiguous IDs
    const idRemap = new Map<number, number>();
    let nextId = 0;
    for (const fp of allFiles) {
      const rawId = filePartition[fp];
      if (rawId === undefined) continue;
      if (!idRemap.has(rawId)) {
        idRemap.set(rawId, nextId++);
      }
      fileAssignments.set(fp, idRemap.get(rawId)!);
    }
  }

  // Handle files with no edges (isolates) — group by directory, then assign to
  // the community that contains the most files from the same directory.
  // This ensures isolated UI files end up in a UI community, not in indexer.
  let nextMacroId =
    fileAssignments.size > 0 ? Math.max(...fileAssignments.values()) + 1 : 0;
  const isolatedFiles: string[] = [];
  for (const fp of allFiles) {
    if (!fileAssignments.has(fp)) {
      isolatedFiles.push(fp);
    }
  }
  if (isolatedFiles.length > 0) {
    // For each isolated file, find the community most common among files in the same directory
    for (const fp of isolatedFiles) {
      const dir = dirname(fp);
      let bestCommunity = -1;
      let bestCount = 0;
      const commCounts = new Map<number, number>();
      for (const [otherFp, cid] of fileAssignments) {
        if (dirname(otherFp) === dir) {
          const count = (commCounts.get(cid) ?? 0) + 1;
          commCounts.set(cid, count);
          if (count > bestCount) {
            bestCount = count;
            bestCommunity = cid;
          }
        }
      }
      if (bestCommunity >= 0) {
        fileAssignments.set(fp, bestCommunity);
      } else {
        // No directory peers — assign to new singleton
        fileAssignments.set(fp, nextMacroId++);
      }
    }
  }

  // Post-process: reassign test files to their strongest target community
  reassignTestFiles(fileAssignments, fileEdges, allFiles);

  // Post-process: merge small communities (≤3 files) into nearest larger community
  mergeSmallCommunities(fileAssignments, fileEdges, allFiles, 3);

  // Remap to contiguous IDs after merging
  {
    const usedIds = new Set(fileAssignments.values());
    const sortedIds = [...usedIds].sort((a, b) => a - b);
    const remap = new Map<number, number>();
    sortedIds.forEach((oldId, idx) => remap.set(oldId, idx));
    for (const [fp, cid] of fileAssignments) {
      fileAssignments.set(fp, remap.get(cid)!);
    }
  }

  // Build macro-community metadata
  const macroNodes = new Map<number, string[]>();
  for (const [fp, cid] of fileAssignments) {
    let nodes = macroNodes.get(cid);
    if (!nodes) {
      nodes = [];
      macroNodes.set(cid, nodes);
    }
    nodes.push(fp);
  }

  const macroCommunities: CommunityInfo[] = [];
  const fileCommunities: FileCommunityAssignment[] = [];

  for (const [cid, files] of macroNodes) {
    const label = generateCommunityLabel(files);
    const cohesion = computeFileCohesion(fileGraph, files);
    macroCommunities.push({ id: cid, label, size: files.length, cohesion });
    for (const fp of files) {
      fileCommunities.push({
        file_path: fp,
        community: cid,
        label,
        cohesion,
      });
    }
  }

  macroCommunities.sort((a, b) => b.size - a.size);

  // ── Phase 2: Entity Sub-Communities ─────────────────────────────

  // Build entity→file lookup
  const entityFileMap = new Map<string, string>();
  for (const e of entities) {
    entityFileMap.set(e.key, e.file_path);
  }

  // Group entities by macro-community
  const macroEntityGroups = new Map<number, string[]>();
  for (const e of entities) {
    const macroCid = fileAssignments.get(e.file_path);
    if (macroCid === undefined) continue;
    let group = macroEntityGroups.get(macroCid);
    if (!group) {
      group = [];
      macroEntityGroups.set(macroCid, group);
    }
    group.push(e.key);
  }

  const entityAssignments = new Map<string, number>();

  // Build entity edge lookup for efficient subgraph extraction
  const entityEdgeSet = new Map<string, Array<{ to: string; type: string }>>();
  for (const edge of entityEdges) {
    let fromEdges = entityEdgeSet.get(edge.from_key);
    if (!fromEdges) {
      fromEdges = [];
      entityEdgeSet.set(edge.from_key, fromEdges);
    }
    fromEdges.push({ to: edge.to_key, type: edge.type });
    // Undirected — add reverse
    let toEdges = entityEdgeSet.get(edge.to_key);
    if (!toEdges) {
      toEdges = [];
      entityEdgeSet.set(edge.to_key, toEdges);
    }
    toEdges.push({ to: edge.from_key, type: edge.type });
  }

  for (const [macroCid, entityKeys] of macroEntityGroups) {
    if (entityKeys.length <= 1) {
      // Single entity — assign directly
      for (const key of entityKeys) {
        entityAssignments.set(key, macroCid * 1000);
      }
      continue;
    }

    // Build subgraph for this macro-community
    const subgraph = new Graph({ type: "undirected", allowSelfLoops: false });
    const entityKeySet = new Set(entityKeys);

    for (const key of entityKeys) {
      subgraph.addNode(key);
    }

    for (const key of entityKeys) {
      const neighbors = entityEdgeSet.get(key);
      if (!neighbors) continue;
      for (const { to, type } of neighbors) {
        if (!entityKeySet.has(to) || key === to) continue;
        if (subgraph.hasEdge(key, to)) continue;
        // Weight: contains=0.3, test→source=0.1, standard=1.0
        let weight = 1.0;
        if (type === "contains") {
          weight = 0.3;
        } else if (type === "tests" || type === "calls") {
          const fromFile = entityFileMap.get(key);
          const toFile = entityFileMap.get(to);
          if (
            fromFile &&
            toFile &&
            isTestFile(fromFile) &&
            !isTestFile(toFile)
          ) {
            weight = 0.1;
          }
        }
        try {
          subgraph.addEdge(key, to, { weight });
        } catch {
          // parallel edge
        }
      }
    }

    // Run Louvain on subgraph
    if (subgraph.size === 0) {
      // No edges — each entity gets its own sub-community
      let localId = 0;
      for (const key of entityKeys) {
        entityAssignments.set(key, macroCid * 1000 + localId++);
      }
      continue;
    }

    const subPartition = louvain(subgraph, {
      resolution: 1.0,
      getEdgeWeight: "weight",
    });

    // Remap sub-community IDs: macro_id * 1000 + local_sub_id
    const subRemap = new Map<number, number>();
    let nextSubId = 0;
    for (const key of entityKeys) {
      const rawSubId = subPartition[key];
      if (rawSubId === undefined) {
        // Isolate within subgraph
        entityAssignments.set(key, macroCid * 1000 + nextSubId++);
        continue;
      }
      if (!subRemap.has(rawSubId)) {
        subRemap.set(rawSubId, nextSubId++);
      }
      entityAssignments.set(key, macroCid * 1000 + subRemap.get(rawSubId)!);
    }

    // Split oversized sub-communities (>25% of macro-community)
    const threshold = entityKeys.length * 0.25;
    splitOversizedSubCommunities(
      subgraph,
      entityAssignments,
      entityKeys,
      macroCid,
      threshold,
      nextSubId
    );
  }

  // ── Phase 3: Consistency Validation ─────────────────────────────

  // Ensure every entity has an assignment
  for (const e of entities) {
    if (!entityAssignments.has(e.key)) {
      const macroCid = fileAssignments.get(e.file_path) ?? 0;
      entityAssignments.set(e.key, macroCid * 1000);
    }
  }

  return { entityAssignments, fileCommunities, macroCommunities };
}

// ── Legacy API (backward compat for existing callers) ────────────

/** @deprecated Use detectCascadedCommunities instead */
export interface CommunityResult {
  assignments: Map<string, number>;
  communities: CommunityInfo[];
}

/** @deprecated Use detectCascadedCommunities instead */
export function detectCommunities(
  entities: { key: string; file_path: string }[],
  edges: { from_key: string; to_key: string; type?: string }[]
): CommunityResult {
  // Delegate to cascaded detection with no file edges (flat fallback)
  const result = detectCascadedCommunities(
    [],
    entities.map((e) => ({ ...e, kind: "function" })),
    edges.map((e) => ({
      from_key: e.from_key,
      to_key: e.to_key,
      type: e.type ?? "calls",
    }))
  );
  return {
    assignments: result.entityAssignments,
    communities: result.macroCommunities,
  };
}

// ── Helper Functions ────────────────────────────────────────────

/**
 * Merge small communities (≤ minSize files) into their nearest larger community.
 * Uses file edge connections first, then directory proximity as fallback.
 */
function mergeSmallCommunities(
  fileAssignments: Map<string, number>,
  fileEdges: FileEdgeInput[],
  allFiles: Set<string>,
  minSize: number
): void {
  // Build community → files map
  const communityFiles = new Map<number, string[]>();
  for (const [fp, cid] of fileAssignments) {
    let files = communityFiles.get(cid);
    if (!files) {
      files = [];
      communityFiles.set(cid, files);
    }
    files.push(fp);
  }

  // Identify large communities (merge targets)
  const largeCommunities = new Set<number>();
  for (const [cid, files] of communityFiles) {
    if (files.length > minSize) largeCommunities.add(cid);
  }

  if (largeCommunities.size === 0) return;

  // Build file→community edge weight map for efficient lookup
  const fileEdgeWeights = new Map<string, Map<number, number>>();
  for (const edge of fileEdges) {
    const fromCid = fileAssignments.get(edge.from_file);
    const toCid = fileAssignments.get(edge.to_file);
    if (fromCid === undefined || toCid === undefined) continue;

    // Record edge from from_file to to_file's community
    if (largeCommunities.has(toCid) && fromCid !== toCid) {
      let weights = fileEdgeWeights.get(edge.from_file);
      if (!weights) {
        weights = new Map();
        fileEdgeWeights.set(edge.from_file, weights);
      }
      weights.set(toCid, (weights.get(toCid) ?? 0) + edge.weight);
    }
    // Reverse direction
    if (largeCommunities.has(fromCid) && toCid !== fromCid) {
      let weights = fileEdgeWeights.get(edge.to_file);
      if (!weights) {
        weights = new Map();
        fileEdgeWeights.set(edge.to_file, weights);
      }
      weights.set(fromCid, (weights.get(fromCid) ?? 0) + edge.weight);
    }
  }

  // Merge small communities
  for (const [cid, files] of communityFiles) {
    if (files.length > minSize || largeCommunities.has(cid)) continue;

    // Strategy 1: find the large community with strongest file edge connections
    const communityWeights = new Map<number, number>();
    for (const fp of files) {
      const weights = fileEdgeWeights.get(fp);
      if (weights) {
        for (const [targetCid, w] of weights) {
          if (largeCommunities.has(targetCid)) {
            communityWeights.set(
              targetCid,
              (communityWeights.get(targetCid) ?? 0) + w
            );
          }
        }
      }
    }

    let bestCommunity: number | null = null;
    let bestWeight = 0;
    for (const [targetCid, w] of communityWeights) {
      if (w > bestWeight) {
        bestWeight = w;
        bestCommunity = targetCid;
      }
    }

    // Strategy 2: fallback to directory proximity — find the large community
    // that shares the most common directory prefix
    if (bestCommunity === null) {
      const dirs = files.map((fp) => dirname(fp));
      const communityDirOverlap = new Map<number, number>();
      for (const dir of dirs) {
        for (const [targetCid, targetFiles] of communityFiles) {
          if (!largeCommunities.has(targetCid)) continue;
          for (const tf of targetFiles) {
            if (dirname(tf) === dir) {
              communityDirOverlap.set(
                targetCid,
                (communityDirOverlap.get(targetCid) ?? 0) + 1
              );
            }
          }
        }
      }
      let bestOverlap = 0;
      for (const [targetCid, overlap] of communityDirOverlap) {
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestCommunity = targetCid;
        }
      }
    }

    // Strategy 3: if still no match, merge into the largest community
    if (bestCommunity === null) {
      let maxSize = 0;
      for (const [targetCid, targetFiles] of communityFiles) {
        if (largeCommunities.has(targetCid) && targetFiles.length > maxSize) {
          maxSize = targetFiles.length;
          bestCommunity = targetCid;
        }
      }
    }

    if (bestCommunity !== null) {
      for (const fp of files) {
        fileAssignments.set(fp, bestCommunity);
      }
      // Update communityFiles for subsequent iterations
      const targetFiles = communityFiles.get(bestCommunity)!;
      targetFiles.push(...files);
      communityFiles.delete(cid);
    }
  }
}

/**
 * Reassign test files to the community of their strongest test target.
 */
function reassignTestFiles(
  fileAssignments: Map<string, number>,
  fileEdges: FileEdgeInput[],
  allFiles: Set<string>
): void {
  for (const fp of allFiles) {
    if (!isTestFile(fp)) continue;

    // Find strongest non-test target
    let bestTarget: string | null = null;
    let bestWeight = 0;
    for (const edge of fileEdges) {
      const from = edge.from_file === fp ? edge.to_file : null;
      const to = edge.to_file === fp ? edge.from_file : null;
      const target = from ?? to;
      if (!target || isTestFile(target) || !allFiles.has(target)) continue;
      if (edge.weight > bestWeight) {
        bestWeight = edge.weight;
        bestTarget = target;
      }
    }

    if (bestTarget) {
      const targetCommunity = fileAssignments.get(bestTarget);
      if (targetCommunity !== undefined) {
        fileAssignments.set(fp, targetCommunity);
      }
    }
  }
}

/**
 * Split oversized sub-communities within a macro-community.
 */
function splitOversizedSubCommunities(
  graph: GraphLike,
  assignments: Map<string, number>,
  entityKeys: string[],
  macroCid: number,
  threshold: number,
  startSubId: number,
  depth = 0
): void {
  if (depth > 3) return;

  // Group by current sub-community
  const subGroups = new Map<number, string[]>();
  for (const key of entityKeys) {
    const cid = assignments.get(key);
    if (cid === undefined) continue;
    let group = subGroups.get(cid);
    if (!group) {
      group = [];
      subGroups.set(cid, group);
    }
    group.push(key);
  }

  let nextSubId = startSubId;
  for (const [cid, nodes] of subGroups) {
    if (nodes.length <= threshold) continue;

    // Build subgraph
    const subgraph = new Graph({ type: "undirected", allowSelfLoops: false });
    const nodeSet = new Set(nodes);
    for (const node of nodes) {
      subgraph.addNode(node);
    }
    for (const node of nodes) {
      graph.forEachEdge(
        node,
        (_edge: string, _attrs: unknown, source: string, target: string) => {
          if (
            nodeSet.has(source) &&
            nodeSet.has(target) &&
            !subgraph.hasEdge(source, target)
          ) {
            try {
              subgraph.addEdge(source, target);
            } catch {
              // parallel edge
            }
          }
        }
      );
    }

    if (subgraph.size === 0) continue;
    const subPartition = louvain(subgraph, { resolution: 1.0 });
    const subIds = new Set(Object.values(subPartition));
    if (subIds.size <= 1) continue;

    // Remap
    const subRemap = new Map<number, number>();
    let firstSub = true;
    for (const node of nodes) {
      const rawId = subPartition[node] as number;
      if (rawId === undefined) continue;
      if (!subRemap.has(rawId)) {
        if (firstSub) {
          subRemap.set(rawId, cid - macroCid * 1000); // Keep original local ID
          firstSub = false;
        } else {
          subRemap.set(rawId, nextSubId++);
        }
      }
      assignments.set(node, macroCid * 1000 + subRemap.get(rawId)!);
    }
  }
}

/**
 * Compute cohesion for file-level nodes in the file graph.
 */
function computeFileCohesion(graph: GraphLike, nodes: string[]): number {
  if (nodes.length < 2) return 0.0;

  const nodeSet = new Set(nodes);
  const countedEdges = new Set<string>();
  let intraEdges = 0;

  for (const node of nodes) {
    if (!graph.hasNode(node)) continue;
    graph.forEachEdge(
      node,
      (edge: string, _attrs: unknown, source: string, target: string) => {
        if (
          nodeSet.has(source) &&
          nodeSet.has(target) &&
          !countedEdges.has(edge)
        ) {
          countedEdges.add(edge);
          intraEdges++;
        }
      }
    );
  }

  const maxPossible = (nodes.length * (nodes.length - 1)) / 2;
  return maxPossible > 0
    ? Math.round((intraEdges / maxPossible) * 1000) / 1000
    : 0.0;
}

/**
 * Generate a community label from the most common file path prefix.
 */
function generateCommunityLabel(filePaths: string[]): string {
  if (filePaths.length === 0) return "unknown";

  const dirPaths = filePaths.map((fp) => {
    const lastSlash = fp.lastIndexOf("/");
    return lastSlash >= 0 ? fp.substring(0, lastSlash) : "";
  });

  const dirCounts = new Map<string, number>();
  for (const dir of dirPaths) {
    const segments = dir.split("/").filter((s) => s.length > 0);
    for (let i = 0; i < segments.length; i++) {
      const prefix = segments.slice(0, i + 1).join("/");
      dirCounts.set(prefix, (dirCounts.get(prefix) ?? 0) + 1);
    }
  }

  const halfCount = filePaths.length / 2;
  let bestDir = "";
  let bestDepth = 0;

  for (const [dir, count] of dirCounts) {
    if (count >= halfCount) {
      const depth = dir.split("/").length;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestDir = dir;
      }
    }
  }

  if (bestDir.length === 0) {
    const singleDirs = new Map<string, number>();
    for (const dir of dirPaths) {
      const parts = dir.split("/").filter((s) => s.length > 0);
      const last = parts[parts.length - 1];
      if (last) {
        singleDirs.set(last, (singleDirs.get(last) ?? 0) + 1);
      }
    }
    let maxCount = 0;
    for (const [dir, count] of singleDirs) {
      if (count > maxCount) {
        maxCount = count;
        bestDir = dir;
      }
    }
    return bestDir || "unknown";
  }

  const segments = bestDir.split("/").filter((s) => s.length > 0);
  const genericPrefixes = new Set([
    "src",
    "lib",
    "app",
    "packages",
    "internal",
    "pkg",
    "cmd",
  ]);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg && !genericPrefixes.has(seg)) {
      return seg;
    }
  }
  return segments[segments.length - 1] ?? "unknown";
}
