/**
 * Layer 7: Intelligence API — graph stats, health, entity detail, ledger-derived insight.
 *
 * All GET handlers. Data is read from in-process CozoDB and tracking modules.
 */

import { Hono } from "hono";
import type { HealthGradeResult } from "../../intelligence/health-grade.js";
import { isTestFile } from "../../intelligence/indexer/test-detector.js";
import type { CozoGraphStore } from "../../intelligence/local-graph.js";
import { computeDomainCoverage } from "../../intelligence/semantic/domain-graph.js";
import {
  computeOverallDurability,
  computePromptDurabilityProfiles,
  getMostFragile,
} from "../../tracking/prompt-durability.js";
import type { LedgerEntry } from "../../tracking/shadow-ledger.js";

const ENTITY_BODY_MAX = 24_000;

export interface IntelligenceRouteDeps {
  /** Null when PARSE / degraded mode without CozoDB graph */
  localGraph: CozoGraphStore | null;
  /** Cached or freshly computed health grade */
  getHealthGrade: () => Promise<HealthGradeResult | null>;
  cwd: string;
  unerrDir: string;
  getRecentLedgerEntries: (limit: number) => LedgerEntry[];
  /** Optional fact store for health map temporal data */
  factStore?: {
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
  } | null;
  /** Optional signal stats getter from QueryRouter (Sprint 9.3) */
  getSignalStats?: () => {
    total_delivered: number;
    by_type: Record<string, number>;
    coverage_pct: number;
  };
}

function slimCallerCallee(e: {
  key: string;
  name: string;
  kind: string;
  file_path: string;
  fan_in: number;
  fan_out: number;
  risk_level: string;
}) {
  return {
    key: e.key,
    name: e.name,
    kind: e.kind,
    file_path: e.file_path,
    fan_in: e.fan_in,
    fan_out: e.fan_out,
    risk_level: e.risk_level,
  };
}

function compactEntityBody<T extends { body: string }>(
  e: T
): T & { body_truncated: boolean } {
  if (e.body.length <= ENTITY_BODY_MAX) {
    return { ...e, body_truncated: false };
  }
  return {
    ...e,
    body: `${e.body.slice(0, ENTITY_BODY_MAX)}…`,
    body_truncated: true,
  };
}

function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function createIntelligenceRoutes(deps: IntelligenceRouteDeps): Hono {
  const app = new Hono();

  app.get("/search", async (c) => {
    const start = performance.now();
    const q = (c.req.query("q") ?? "").trim();
    const limit = parseLimit(c.req.query("limit"), 20, 50);

    if (!deps.localGraph) {
      return c.json(
        {
          data: [],
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    if (q.length === 0) {
      return c.json({
        data: [],
        _meta: {
          source: "local",
          empty_query: true,
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }

    const results = await deps.localGraph.searchEntities(q, limit);
    return c.json({
      data: results,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/graph-stats", async (c) => {
    const start = performance.now();
    if (!deps.localGraph) {
      return c.json(
        {
          data: null,
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }
    const stats = await deps.localGraph.getLocalProjectStats();
    return c.json({
      data: stats,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/health", async (c) => {
    const start = performance.now();
    const grade = await deps.getHealthGrade();
    if (!grade) {
      return c.json({
        data: null,
        _meta: {
          source: "local",
          graph: "unavailable",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    }
    return c.json({
      data: grade,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/top-entities", async (c) => {
    const start = performance.now();
    const limit = parseLimit(c.req.query("limit"), 10, 50);
    const communityRaw = c.req.query("community");
    const communityId =
      communityRaw !== undefined && communityRaw !== ""
        ? Number.parseInt(communityRaw, 10)
        : undefined;

    if (!deps.localGraph) {
      return c.json(
        {
          data: [],
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    const nodes =
      communityId !== undefined && !Number.isNaN(communityId)
        ? await deps.localGraph.getCriticalNodes(limit, communityId)
        : await deps.localGraph.getCriticalNodes(limit);

    return c.json({
      data: nodes,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // R2: Reading Tour — top backbone files for an unfamiliar repo.
  // Picks the top-N most-depended-on entities, dedupes by file, generates a "why" line.
  app.get("/reading-tour", async (c) => {
    const start = performance.now();
    const limit = parseLimit(c.req.query("limit"), 5, 10);

    if (!deps.localGraph) {
      return c.json(
        {
          data: { stops: [], estimatedReadingTimeMin: 0 },
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    // Pull a generous candidate pool so we can dedupe by file and still hit limit.
    const candidates = await deps.localGraph.getCriticalNodes(limit * 6);

    const seenFiles = new Set<string>();
    const stops: Array<{
      rank: number;
      key: string;
      name: string;
      file_path: string;
      kind: string;
      fan_in: number;
      community_label: string;
      why: string;
    }> = [];

    for (const node of candidates) {
      if (stops.length >= limit) break;
      if (seenFiles.has(node.file_path)) continue;
      seenFiles.add(node.file_path);

      const why =
        node.fan_in >= 30
          ? `Called from ${node.fan_in} places — load-bearing.`
          : node.fan_in >= 15
            ? `${node.fan_in} dependents — touched by most of the codebase.`
            : `${node.fan_in} dependents — a structural anchor.`;

      stops.push({
        rank: stops.length + 1,
        key: node.key,
        name: node.name,
        file_path: node.file_path,
        kind: node.kind,
        fan_in: node.fan_in,
        community_label: node.community_label,
        why,
      });
    }

    return c.json({
      data: {
        stops,
        estimatedReadingTimeMin: Math.max(10, stops.length * 5),
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/entity/:key", async (c) => {
    const start = performance.now();
    const key = decodeURIComponent(c.req.param("key"));

    if (!deps.localGraph) {
      return c.json(
        {
          data: null,
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    const entity = await deps.localGraph.getEntity(key);
    if (!entity) {
      return c.json(
        {
          data: null,
          _meta: {
            source: "local",
            not_found: key,
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        404
      );
    }

    const [callers, callees] = await Promise.all([
      deps.localGraph.getCallersOf(key),
      deps.localGraph.getCalleesOf(key),
    ]);

    const slimmed = callers.map(slimCallerCallee);
    const productionCallers = slimmed.filter((c) => !isTestFile(c.file_path));
    const testCallers = slimmed.filter((c) => isTestFile(c.file_path));

    return c.json({
      data: {
        entity: compactEntityBody(entity),
        callers: slimmed,
        production_callers: productionCallers,
        test_callers: testCallers,
        callees: callees.map(slimCallerCallee),
      },
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/test-coverage/:key", async (c) => {
    const start = performance.now();
    const key = decodeURIComponent(c.req.param("key"));
    const includeTransitive = c.req.query("transitive") !== "false";

    if (!deps.localGraph) {
      return c.json(
        {
          data: [],
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    const coverage = await deps.localGraph.getTestCoverage(
      key,
      includeTransitive
    );
    return c.json({
      data: coverage,
      _meta: {
        source: "local",
        entity_key: key,
        include_transitive: includeTransitive,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/conventions", async (c) => {
    const start = performance.now();
    const { learnConventions } = await import(
      "../../intelligence/convention-learner.js"
    );
    const entries = deps.getRecentLedgerEntries(500);
    const conventions = learnConventions(entries);
    return c.json({
      data: conventions,
      _meta: {
        source: "local",
        ledger_entries_sampled: entries.length,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/causal/:key", async (c) => {
    const start = performance.now();
    const key = decodeURIComponent(c.req.param("key"));
    const { CausalBridge } = await import("../../tracking/causal-bridge.js");
    const bridge = new CausalBridge(deps.unerrDir, deps.cwd);
    const chain = await bridge.buildCausalChain(key);
    return c.json({
      data: chain,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/graph-visual", async (c) => {
    const start = performance.now();
    if (!deps.localGraph) {
      return c.json(
        {
          data: { nodes: [], edges: [], communities: [] },
          _meta: {
            source: "local",
            graph: "unavailable",
            view_mode: "flat" as const,
            node_count: 0,
            edge_count: 0,
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    // Fetch ALL entities and edges — no community filter (file-as-L0 approach)
    const [entityResult, edgeResult] = await Promise.all([
      deps.localGraph.db.run(
        `?[key, name, fp, fi, fo, community, rl, kind] :=
          *entities{key, name, file_path: fp, fan_in: fi, fan_out: fo, community, risk_level: rl, kind},
          kind != "file", kind != "module"`
      ),
      deps.localGraph.db.run(
        "?[from_key, to_key, type] := *edges{from_key, to_key, type}"
      ),
    ]);

    // Use single source of truth for test detection (8-language support)

    // Separate "contains" edges (parent→child) from relationship edges
    const containsChildren = new Map<string, Set<string>>(); // parent → Set<child>
    const childToParent = new Map<string, string>(); // child → parent
    const relationshipEdges: Array<{ from: string; to: string; type: string }> =
      [];

    for (const row of edgeResult.rows) {
      const from = row[0] as string;
      const to = row[1] as string;
      const type = row[2] as string;
      if (type === "contains") {
        if (!containsChildren.has(from)) containsChildren.set(from, new Set());
        containsChildren.get(from)?.add(to);
        childToParent.set(to, from);
      } else {
        relationshipEdges.push({ from, to, type });
      }
    }

    // Build entity map for quick lookup
    const entityMap = new Map<
      string,
      {
        key: string;
        name: string;
        fp: string;
        fi: number;
        fo: number;
        community: number;
        rl: string;
        kind: string;
      }
    >();
    for (const row of entityResult.rows) {
      const [key, name, fp, fi, fo, community, rl, kind] = row as [
        string,
        string,
        string,
        number,
        number,
        number,
        string,
        string,
      ];
      entityMap.set(key, { key, name, fp, fi, fo, community, rl, kind });
    }

    // Kinds that should be collapsed into their parent node
    const COLLAPSIBLE_KINDS = new Set([
      "method",
      "constructor",
      "type",
      "interface",
      "enum",
      "property",
    ]);

    // Determine which entities are "child" entities that should collapse into parent
    const collapsedInto = new Map<string, string>(); // child → visual parent
    const memberCounts = new Map<string, number>(); // parent → member count

    for (const [child, parent] of childToParent) {
      const childEntity = entityMap.get(child);
      if (!childEntity) continue;
      if (entityMap.has(parent) && COLLAPSIBLE_KINDS.has(childEntity.kind)) {
        collapsedInto.set(child, parent);
        memberCounts.set(parent, (memberCounts.get(parent) ?? 0) + 1);
      }
    }

    // Redirect edges that point to/from collapsed children to their parent
    const redirectedEdges: Array<{ from: string; to: string; type: string }> =
      [];
    const edgeDedup = new Set<string>();
    for (const e of relationshipEdges) {
      const from = collapsedInto.get(e.from) ?? e.from;
      const to = collapsedInto.get(e.to) ?? e.to;
      if (from === to) continue;
      const dedupKey = `${from}→${to}→${e.type}`;
      if (edgeDedup.has(dedupKey)) continue;
      edgeDedup.add(dedupKey);
      redirectedEdges.push({ from, to, type: e.type });
    }

    // Build final node list (excluding collapsed children)
    const nodeKeys = new Set<string>();
    let collapsedCount = 0;
    const nodes: Array<{
      id: string;
      label: string;
      kind: string;
      file: string;
      fileGroup: string;
      fanIn: number;
      fanOut: number;
      community: number;
      risk: string;
      isTest: boolean;
      members: number;
      externalOut: number;
      externalIn: number;
    }> = [];

    for (const [key, ent] of entityMap) {
      if (collapsedInto.has(key)) {
        collapsedCount++;
        continue;
      }
      nodeKeys.add(key);
      nodes.push({
        id: key,
        label: ent.name,
        kind: ent.kind,
        file: ent.fp,
        fileGroup: ent.fp,
        fanIn: ent.fi,
        fanOut: ent.fo,
        community: ent.community,
        risk: ent.rl,
        isTest: isTestFile(ent.fp),
        members: memberCounts.get(key) ?? 0,
        externalOut: 0,
        externalIn: 0,
      });
    }

    // Final edge filter: only edges where both endpoints are visible
    const edges = redirectedEdges.filter(
      (e) => nodeKeys.has(e.from) && nodeKeys.has(e.to)
    );

    // Compute external (cross-community) edge counts per node
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    for (const e of edges) {
      const fromNode = nodeById.get(e.from);
      const toNode = nodeById.get(e.to);
      if (fromNode && toNode && fromNode.community !== toNode.community) {
        fromNode.externalOut++;
        toNode.externalIn++;
      }
    }

    // ─── File-as-L0: Read materialized file-level data ─────────────────────
    // Group entities by file_path
    const fileEntityMap = new Map<string, typeof nodes>(); // filePath → entities in that file
    for (const n of nodes) {
      const list = fileEntityMap.get(n.file) ?? [];
      list.push(n);
      fileEntityMap.set(n.file, list);
    }

    // Read materialized file edges from CozoDB (computed at index time)
    const fileEdges: Array<{ from: string; to: string; weight: number }> = [];
    const fileEdgeWeights = new Map<string, number>(); // "from→to" → weight for position computation
    try {
      const feResult = await deps.localGraph.db.run(
        "?[from_file, to_file, weight] := *file_edges{from_file, to_file, weight}"
      );
      for (const row of feResult.rows) {
        const from = row[0] as string;
        const to = row[1] as string;
        const weight = row[2] as number;
        fileEdges.push({ from, to, weight });
        const key = `${from}→${to}`;
        fileEdgeWeights.set(key, (fileEdgeWeights.get(key) ?? 0) + weight);
      }
    } catch {
      // File edges not yet materialized — empty
    }

    // Read materialized file communities from CozoDB
    const fileCommunityAssignment = new Map<string, number>();
    const fileCommunityLabels = new Map<number, string>();
    const fileCommunityCohesion = new Map<number, number>();
    try {
      const fcResult = await deps.localGraph.db.run(
        "?[file_path, community, label, cohesion] := *file_communities{file_path, community, label, cohesion}"
      );
      for (const row of fcResult.rows) {
        const fp = row[0] as string;
        const cid = row[1] as number;
        fileCommunityAssignment.set(fp, cid);
        fileCommunityLabels.set(cid, row[2] as string);
        fileCommunityCohesion.set(cid, row[3] as number);
      }
    } catch {
      // File communities not yet materialized — fallback: all in community 0
    }

    // Fallback: assign files without a community
    for (const fp of fileEntityMap.keys()) {
      if (!fileCommunityAssignment.has(fp)) {
        fileCommunityAssignment.set(fp, 0);
      }
    }

    // Build file nodes with aggregated metrics
    const fileNodes: Array<{
      id: string;
      label: string;
      filePath: string;
      entityCount: number;
      totalFanIn: number;
      totalFanOut: number;
      fileCommunity: number;
      maxRisk: string;
      isTest: boolean;
      kinds: Record<string, number>;
      externalOut: number;
      externalIn: number;
    }> = [];

    const RISK_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

    for (const [fp, ents] of fileEntityMap) {
      const kinds: Record<string, number> = {};
      let totalFanIn = 0;
      let totalFanOut = 0;
      let maxRiskLevel = "low";

      for (const ent of ents) {
        kinds[ent.kind] = (kinds[ent.kind] ?? 0) + 1;
        totalFanIn += ent.fanIn;
        totalFanOut += ent.fanOut;
        if ((RISK_ORDER[ent.risk] ?? 0) > (RISK_ORDER[maxRiskLevel] ?? 0)) {
          maxRiskLevel = ent.risk;
        }
      }

      const myComm = fileCommunityAssignment.get(fp) ?? 0;
      let extOut = 0;
      let extIn = 0;
      for (const fe of fileEdges) {
        if (fe.from === fp) {
          const targetComm = fileCommunityAssignment.get(fe.to) ?? 0;
          if (targetComm !== myComm) extOut += fe.weight;
        }
        if (fe.to === fp) {
          const sourceComm = fileCommunityAssignment.get(fe.from) ?? 0;
          if (sourceComm !== myComm) extIn += fe.weight;
        }
      }

      const filename = fp.split("/").pop() ?? fp;
      fileNodes.push({
        id: fp,
        label: filename,
        filePath: fp,
        entityCount: ents.length,
        totalFanIn,
        totalFanOut,
        fileCommunity: myComm,
        maxRisk: maxRiskLevel,
        isTest: isTestFile(fp),
        kinds,
        externalOut: extOut,
        externalIn: extIn,
      });
    }

    // Build file communities from materialized data
    const fileCommunityGroups = new Map<number, string[]>();
    for (const [fp, comm] of fileCommunityAssignment) {
      const list = fileCommunityGroups.get(comm) ?? [];
      list.push(fp);
      fileCommunityGroups.set(comm, list);
    }

    const fileCommunities: Array<{
      id: number;
      label: string;
      fileCount: number;
      entityCount: number;
      cohesion: number;
      files: string[];
      inter_edges: Array<{ target: number; weight: number }>;
    }> = [];

    for (const [commId, files] of fileCommunityGroups) {
      const label = fileCommunityLabels.get(commId) ?? `cluster-${commId}`;
      const cohesion = fileCommunityCohesion.get(commId) ?? 1.0;

      let entityCount = 0;
      for (const fp of files) {
        entityCount += fileEntityMap.get(fp)?.length ?? 0;
      }

      // Inter-community edges from materialized file edges
      const interEdgeMap = new Map<number, number>();
      for (const fe of fileEdges) {
        const fromComm = fileCommunityAssignment.get(fe.from) ?? -1;
        const toComm = fileCommunityAssignment.get(fe.to) ?? -1;
        if (fromComm === commId && toComm !== commId && toComm >= 0) {
          interEdgeMap.set(toComm, (interEdgeMap.get(toComm) ?? 0) + fe.weight);
        }
      }

      fileCommunities.push({
        id: commId,
        label,
        fileCount: files.length,
        entityCount,
        cohesion: Math.round(cohesion * 100) / 100,
        files,
        inter_edges: Array.from(interEdgeMap.entries()).map(
          ([target, weight]) => ({ target, weight })
        ),
      });
    }

    // Compute cross-community external counts on entity nodes
    for (const n of nodes) {
      const myFileComm = fileCommunityAssignment.get(n.file) ?? 0;
      n.externalOut = 0;
      n.externalIn = 0;
      for (const e of edges) {
        if (e.from === n.id) {
          const targetNode = nodeById.get(e.to);
          if (
            targetNode &&
            (fileCommunityAssignment.get(targetNode.file) ?? 0) !== myFileComm
          ) {
            n.externalOut++;
          }
        }
        if (e.to === n.id) {
          const sourceNode = nodeById.get(e.from);
          if (
            sourceNode &&
            (fileCommunityAssignment.get(sourceNode.file) ?? 0) !== myFileComm
          ) {
            n.externalIn++;
          }
        }
      }
    }

    // Read class edges for L1 class-level visualization
    let classEdges: Array<{
      from: string;
      to: string;
      type: string;
      weight: number;
    }> = [];
    try {
      const ceResult = await deps.localGraph.db.run(
        "?[from_class, to_class, edge_type, weight] := *class_edges{from_class, to_class, edge_type, weight}"
      );
      classEdges = ceResult.rows.map((row) => ({
        from: row[0] as string,
        to: row[1] as string,
        type: row[2] as string,
        weight: row[3] as number,
      }));
    } catch {
      // Class edges not materialized — empty
    }

    // Determine view_mode based on file count and file community count
    const totalFileCount = fileNodes.length;
    const totalFileCommunities = fileCommunities.length;
    let viewMode: "flat" | "file-clusters" | "hierarchical";
    if (totalFileCommunities <= 2 && totalFileCount < 15) {
      viewMode = "flat";
    } else if (totalFileCommunities <= 3) {
      viewMode = "file-clusters";
    } else {
      viewMode = "hierarchical";
    }

    // ─── Server-side position pre-computation ──────────────────────────────
    const positions: {
      communities: Record<number, { x: number; y: number }>;
      files: Record<string, { x: number; y: number }>;
      entities: Record<string, { x: number; y: number }>;
    } = { communities: {}, files: {}, entities: {} };

    try {
      const graphologyMod = (await import("graphology")) as any;
      const fa2Mod = (await import("graphology-layout-forceatlas2")) as any;
      const Graph = graphologyMod.default ?? graphologyMod;
      const forceAtlas2 = fa2Mod.default ?? fa2Mod;

      // Community-level positions
      if (fileCommunities.length > 1) {
        const commGraph = new Graph({ type: "undirected" });
        for (const comm of fileCommunities) {
          commGraph.addNode(String(comm.id), {
            x: Math.random() * 100 - 50,
            y: Math.random() * 100 - 50,
            size: comm.entityCount,
          });
        }
        for (const comm of fileCommunities) {
          for (const ie of comm.inter_edges) {
            if (
              commGraph.hasNode(String(ie.target)) &&
              !commGraph.hasEdge(String(comm.id), String(ie.target))
            ) {
              commGraph.addEdge(String(comm.id), String(ie.target), {
                weight: ie.weight,
              });
            }
          }
        }
        forceAtlas2.assign(commGraph, {
          iterations: 100,
          settings: {
            gravity: 1,
            scalingRatio: 10,
            strongGravityMode: true,
            barnesHutOptimize: true,
          },
        });
        commGraph.forEachNode((node: string, attrs: any) => {
          positions.communities[Number(node)] = {
            x: Math.round(attrs.x),
            y: Math.round(attrs.y),
          };
        });
      }

      // File-level positions (one layout per community)
      for (const comm of fileCommunities) {
        const filesInComm = comm.files;
        if (filesInComm.length === 0) continue;
        const fileGraph = new Graph({ type: "undirected" });
        for (const fp of filesInComm) {
          fileGraph.addNode(fp, {
            x: Math.random() * 100 - 50,
            y: Math.random() * 100 - 50,
            size: fileEntityMap.get(fp)?.length ?? 1,
          });
        }
        for (const [key, weight] of fileEdgeWeights) {
          const parts = key.split("→");
          const from = parts[0]!;
          const to = parts[1]!;
          if (
            fileGraph.hasNode(from) &&
            fileGraph.hasNode(to) &&
            !fileGraph.hasEdge(from, to)
          ) {
            fileGraph.addEdge(from, to, { weight });
          }
        }
        if (fileGraph.order > 1) {
          forceAtlas2.assign(fileGraph, {
            iterations: 80,
            settings: {
              gravity: 2,
              scalingRatio: 5,
              barnesHutOptimize: fileGraph.order > 30,
            },
          });
        }
        fileGraph.forEachNode((node: string, attrs: any) => {
          positions.files[node] = {
            x: Math.round(attrs.x),
            y: Math.round(attrs.y),
          };
        });
      }

      // Entity-level positions (vertical code-order layout per file)
      for (const [, ents] of fileEntityMap) {
        if (ents.length <= 1) {
          if (ents.length === 1) {
            const ent0 = ents[0];
            if (ent0) positions.entities[ent0.id] = { x: 0, y: 0 };
          }
          continue;
        }
        const sorted = [...ents].sort((a, b) => {
          const kindOrder: Record<string, number> = {
            class: 0,
            function: 1,
            variable: 2,
          };
          const ka = kindOrder[a.kind] ?? 3;
          const kb = kindOrder[b.kind] ?? 3;
          if (ka !== kb) return ka - kb;
          return a.label.localeCompare(b.label);
        });
        sorted.forEach((ent, i) => {
          positions.entities[ent.id] = { x: 0, y: i * 60 };
        });
      }
    } catch {
      // Position computation is non-critical — frontend falls back to force-directed
    }

    return c.json({
      data: {
        nodes,
        edges,
        fileNodes,
        fileEdges,
        fileCommunities,
        classEdges,
        positions,
      },
      _meta: {
        source: "local",
        view_mode: viewMode,
        node_count: nodes.length,
        edge_count: edges.length,
        file_count: totalFileCount,
        file_edge_count: fileEdges.length,
        class_edge_count: classEdges.length,
        collapsed_count: collapsedCount,
        total_entities: entityResult.rows.length,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/risk-hotspots", async (c) => {
    const start = performance.now();
    const limit = parseLimit(c.req.query("limit"), 20, 50);

    if (!deps.localGraph) {
      return c.json(
        {
          data: [],
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    // Get top entities by degree
    const topNodes = await deps.localGraph.getCriticalNodes(limit);

    // Batch test coverage check: for each entity, count direct + transitive test edges
    // Single Datalog query to get test counts for all keys at once
    const keys = topNodes.map((n) => n.key);
    const testCountMap = new Map<string, number>();

    if (keys.length > 0) {
      try {
        // Direct tests
        const directResult = await deps.localGraph.db.run(
          `?[target, count(tk)] := *edges{from_key: tk, to_key: target, type: "tests"},
            target in $keys`,
          { keys }
        );
        for (const row of directResult.rows) {
          testCountMap.set(row[0] as string, row[1] as number);
        }

        // Transitive tests (depth 2: test → caller → target)
        const transitiveResult = await deps.localGraph.db.run(
          `?[target, count(tk)] := *edges{from_key: mid, to_key: target, type: "calls"},
            *edges{from_key: tk, to_key: mid, type: "tests"},
            target in $keys`,
          { keys }
        );
        for (const row of transitiveResult.rows) {
          const key = row[0] as string;
          const existing = testCountMap.get(key) ?? 0;
          testCountMap.set(key, existing + (row[1] as number));
        }
      } catch {
        // Test coverage query failed — leave counts at 0
      }
    }

    // Also get caller counts for blast radius context
    const callerCountMap = new Map<string, number>();
    if (keys.length > 0) {
      try {
        const callerResult = await deps.localGraph.db.run(
          `?[target, count(caller)] := *edges{from_key: caller, to_key: target, type: "calls"},
            target in $keys`,
          { keys }
        );
        for (const row of callerResult.rows) {
          callerCountMap.set(row[0] as string, row[1] as number);
        }
      } catch {
        // Caller count query failed — leave counts at 0
      }
    }

    const hotspots = topNodes.map((n) => ({
      key: n.key,
      name: n.name,
      file_path: n.file_path,
      kind: n.kind,
      fan_in: n.fan_in,
      fan_out: n.fan_out,
      degree: n.degree,
      risk_level: n.risk_level,
      community_label: n.community_label,
      test_count: testCountMap.get(n.key) ?? 0,
      caller_count: callerCountMap.get(n.key) ?? 0,
    }));

    return c.json({
      data: hotspots,
      _meta: {
        source: "local",
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/insights", async (c) => {
    const start = performance.now();

    if (!deps.localGraph) {
      return c.json(
        {
          data: null,
          _meta: {
            source: "local",
            graph: "unavailable",
            latency_ms: Math.round((performance.now() - start) * 100) / 100,
          },
        },
        503
      );
    }

    // ── Gather raw data with parallel queries ──────────────────────────
    const topN = 50; // Analyze more than we show for accurate metrics
    const topNodes = await deps.localGraph.getCriticalNodes(topN);
    const keys = topNodes.map((n) => n.key);

    // Batch test coverage for all top entities
    const testCountMap = new Map<string, number>();
    if (keys.length > 0) {
      try {
        const directResult = await deps.localGraph.db.run(
          `?[target, count(tk)] := *edges{from_key: tk, to_key: target, type: "tests"},
            target in $keys`,
          { keys }
        );
        for (const row of directResult.rows) {
          testCountMap.set(row[0] as string, row[1] as number);
        }
        const transitiveResult = await deps.localGraph.db.run(
          `?[target, count(tk)] := *edges{from_key: mid, to_key: target, type: "calls"},
            *edges{from_key: tk, to_key: mid, type: "tests"},
            target in $keys`,
          { keys }
        );
        for (const row of transitiveResult.rows) {
          const k = row[0] as string;
          testCountMap.set(k, (testCountMap.get(k) ?? 0) + (row[1] as number));
        }
      } catch {
        // Test coverage unavailable
      }
    }

    // ── Compute blast-radius-weighted coverage ────────────────────────
    // Weight each entity by its fan_in (how many things depend on it)
    let totalBlastRadius = 0;
    let testedBlastRadius = 0;
    let untestedBlastRadius = 0;
    for (const n of topNodes) {
      const weight = Math.max(n.fan_in, 1); // min 1 so isolated entities still count
      totalBlastRadius += weight;
      if ((testCountMap.get(n.key) ?? 0) > 0) {
        testedBlastRadius += weight;
      } else {
        untestedBlastRadius += weight;
      }
    }
    const blastRadiusCoverage =
      totalBlastRadius > 0
        ? Math.round((testedBlastRadius / totalBlastRadius) * 100)
        : 0;

    // ── Identify bottlenecks ──────────────────────────────────────────
    // Bottleneck = high fan_in AND high fan_out AND zero tests
    // These are structural chokepoints — everything flows through them
    const bottlenecks = topNodes
      .filter(
        (n) =>
          n.fan_in >= 3 &&
          n.fan_out >= 2 &&
          (testCountMap.get(n.key) ?? 0) === 0
      )
      .map((n) => ({
        key: n.key,
        name: n.name,
        file_path: n.file_path,
        kind: n.kind,
        fan_in: n.fan_in,
        fan_out: n.fan_out,
        degree: n.degree,
        risk_level: n.risk_level,
      }));

    // ── Risk distribution ─────────────────────────────────────────────
    const riskDistribution = { high: 0, medium: 0, low: 0 };
    for (const n of topNodes) {
      const level = n.risk_level as keyof typeof riskDistribution;
      if (level in riskDistribution) riskDistribution[level]++;
    }

    // ── Risk concentration ────────────────────────────────────────────
    // What % of total degree sits in the top 5 entities?
    const sortedByDegree = [...topNodes].sort((a, b) => b.degree - a.degree);
    const totalDegree = topNodes.reduce((s, n) => s + n.degree, 0);
    const top5Degree = sortedByDegree
      .slice(0, 5)
      .reduce((s, n) => s + n.degree, 0);
    const riskConcentration =
      totalDegree > 0 ? Math.round((top5Degree / totalDegree) * 100) : 0;

    // ── Community health ──────────────────────────────────────────────
    const communityMap = new Map<
      string,
      {
        label: string;
        community: number;
        entities: number;
        totalDegree: number;
        riskHigh: number;
        riskMedium: number;
        riskLow: number;
        untested: number;
        tested: number;
        totalFanIn: number;
        untestedFanIn: number;
      }
    >();

    for (const n of topNodes) {
      const label = n.community_label || `cluster-${n.community}`;
      let comm = communityMap.get(label);
      if (!comm) {
        comm = {
          label,
          community: n.community,
          entities: 0,
          totalDegree: 0,
          riskHigh: 0,
          riskMedium: 0,
          riskLow: 0,
          untested: 0,
          tested: 0,
          totalFanIn: 0,
          untestedFanIn: 0,
        };
        communityMap.set(label, comm);
      }
      comm.entities++;
      comm.totalDegree += n.degree;
      comm.totalFanIn += n.fan_in;
      const hasCoverage = (testCountMap.get(n.key) ?? 0) > 0;
      if (hasCoverage) comm.tested++;
      else {
        comm.untested++;
        comm.untestedFanIn += n.fan_in;
      }
      if (n.risk_level === "high") comm.riskHigh++;
      else if (n.risk_level === "medium") comm.riskMedium++;
      else comm.riskLow++;
    }

    // SC-D.3: name communities by their voted domain. Load the
    // community_domains vote so the dashboard can show "auth (88%)" instead of
    // a bare cluster id. Best-effort — empty when the relation is unmaterialized.
    const communityDomainMap = new Map<
      number,
      { domain: string; purity: number }
    >();
    try {
      const cdResult = await deps.localGraph.db.run(
        `?[community_id, domain, purity] :=
           *community_domains{community_id, domain, purity}, domain != ""`
      );
      for (const row of cdResult.rows) {
        communityDomainMap.set(row[0] as number, {
          domain: row[1] as string,
          purity: row[2] as number,
        });
      }
    } catch {
      // community_domains not yet materialized — communities stay unnamed.
    }

    // Read cohesion data from file communities if available
    const communityHealth: Array<{
      label: string;
      domain?: string;
      domainPurityPct?: number;
      entities: number;
      tested: number;
      untested: number;
      coveragePct: number;
      blastRadiusCoveragePct: number;
      riskHigh: number;
      riskMedium: number;
      riskLow: number;
      totalDegree: number;
    }> = [];

    for (const [, comm] of communityMap) {
      const total = comm.tested + comm.untested;
      const domainVote = communityDomainMap.get(comm.community);
      communityHealth.push({
        label: comm.label,
        ...(domainVote
          ? {
              domain: domainVote.domain,
              domainPurityPct: Math.round(domainVote.purity * 100),
            }
          : {}),
        entities: comm.entities,
        tested: comm.tested,
        untested: comm.untested,
        coveragePct: total > 0 ? Math.round((comm.tested / total) * 100) : 0,
        blastRadiusCoveragePct:
          comm.totalFanIn > 0
            ? Math.round(
                ((comm.totalFanIn - comm.untestedFanIn) / comm.totalFanIn) * 100
              )
            : 0,
        riskHigh: comm.riskHigh,
        riskMedium: comm.riskMedium,
        riskLow: comm.riskLow,
        totalDegree: comm.totalDegree,
      });
    }

    // Sort communities: worst blast-radius coverage first
    communityHealth.sort(
      (a, b) => a.blastRadiusCoveragePct - b.blastRadiusCoveragePct
    );

    // ── Most coupled community pair ───────────────────────────────────
    let mostCoupledPair: {
      from: string;
      to: string;
      weight: number;
    } | null = null;

    try {
      const fcResult = await deps.localGraph.db.run(
        `?[from_label, to_label, w] :=
          *file_edges{from_file, to_file, weight: w},
          *file_communities{file_path: from_file, label: from_label},
          *file_communities{file_path: to_file, label: to_label},
          from_label != to_label
         :order -w
         :limit 1`
      );
      if (fcResult.rows.length > 0) {
        const [from, to, weight] = fcResult.rows[0] as [string, string, number];
        mostCoupledPair = { from, to, weight };
      }
    } catch {
      // File communities not available
    }

    // ── Generate narrative insights ───────────────────────────────────
    const insights: Array<{
      id: string;
      severity: "critical" | "warning" | "info" | "positive";
      title: string;
      description: string;
      metric?: number;
      metricLabel?: string;
    }> = [];

    // Insight 1: Blast-radius-weighted coverage gap
    if (blastRadiusCoverage < 50) {
      insights.push({
        id: "blast-radius-coverage",
        severity: "critical",
        title: `Blast-radius coverage is only ${blastRadiusCoverage}%`,
        description: `${untestedBlastRadius} dependency-weighted risk sits in untested code. Your entity-count coverage looks better but hides that your most-depended-on code is unprotected.`,
        metric: blastRadiusCoverage,
        metricLabel: "blast-radius coverage",
      });
    } else if (blastRadiusCoverage < 75) {
      insights.push({
        id: "blast-radius-coverage",
        severity: "warning",
        title: `Blast-radius coverage at ${blastRadiusCoverage}%`,
        description: `Your most critical code paths are partially covered, but ${untestedBlastRadius} dependency-weight remains untested.`,
        metric: blastRadiusCoverage,
        metricLabel: "blast-radius coverage",
      });
    } else {
      insights.push({
        id: "blast-radius-coverage",
        severity: "positive",
        title: `Strong blast-radius coverage: ${blastRadiusCoverage}%`,
        description:
          "Your highest-impact code paths are well tested. Regressions are unlikely to cascade silently.",
        metric: blastRadiusCoverage,
        metricLabel: "blast-radius coverage",
      });
    }

    // Insight 2: Bottleneck alert
    if (bottlenecks.length > 0) {
      const totalBottleneckFanIn = bottlenecks.reduce(
        (s, b) => s + b.fan_in,
        0
      );
      insights.push({
        id: "bottlenecks",
        severity: bottlenecks.length >= 5 ? "critical" : "warning",
        title: `${bottlenecks.length} structural bottleneck${bottlenecks.length !== 1 ? "s" : ""} with zero tests`,
        description: `These functions have high fan-in AND fan-out — all dependency traffic flows through them. Combined, ${totalBottleneckFanIn} dependents are exposed. A failure in any one cascades in both directions.`,
        metric: bottlenecks.length,
        metricLabel: "bottlenecks",
      });
    }

    // Insight 3: Risk concentration
    if (riskConcentration > 40) {
      insights.push({
        id: "risk-concentration",
        severity: riskConcentration > 60 ? "warning" : "info",
        title: `${riskConcentration}% of structural risk concentrated in top 5 entities`,
        description: `Your risk isn't spread evenly — a small number of entities carry most of the dependency weight. Focus testing and review here for maximum impact.`,
        metric: riskConcentration,
        metricLabel: "risk in top 5",
      });
    }

    // Insight 4: Most coupled pair
    if (mostCoupledPair && mostCoupledPair.weight >= 3) {
      insights.push({
        id: "coupling-hotspot",
        severity: mostCoupledPair.weight >= 10 ? "warning" : "info",
        title: `"${mostCoupledPair.from}" and "${mostCoupledPair.to}" are tightly coupled`,
        description: `${mostCoupledPair.weight} cross-boundary calls between these modules. Changes in one are likely to require changes in the other.`,
        metric: mostCoupledPair.weight,
        metricLabel: "cross-boundary calls",
      });
    }

    // Insight 5: Positive — low risk distribution
    if (riskDistribution.high === 0 && topNodes.length > 0) {
      insights.push({
        id: "no-high-risk",
        severity: "positive",
        title: "No high-risk entities detected",
        description:
          "Your top entities are well-balanced with moderate dependency counts. The codebase structure is healthy.",
      });
    }

    // ── Health score (0-100) ──────────────────────────────────────────
    // Weighted: 40% blast-radius coverage, 25% bottleneck penalty, 20% risk spread, 15% high-risk penalty
    const bottleneckPenalty = Math.min(bottlenecks.length * 5, 25);
    const highRiskPenalty = Math.min(riskDistribution.high * 3, 15);
    const concentrationPenalty =
      riskConcentration > 50 ? (riskConcentration - 50) * 0.4 : 0;
    const healthScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          blastRadiusCoverage * 0.4 +
            (100 - bottleneckPenalty) * 0.25 +
            (100 - concentrationPenalty) * 0.2 +
            (100 - highRiskPenalty) * 0.15
        )
      )
    );

    const healthGrade =
      healthScore >= 90
        ? "A"
        : healthScore >= 80
          ? "B"
          : healthScore >= 65
            ? "C"
            : healthScore >= 50
              ? "D"
              : "F";

    // ── Domain coverage by provenance tier (SC-E.3) ───────────────────────
    // Per domain, how many entities are tagged at each provenance tier
    // (comment 0.95 > harvested 0.7 > propagated 0.6 > path 0.4). Surfaces the
    // *quality* of domain coverage: comment-authored is durable human intent;
    // path-inferred is a weak graph guess. Additive — never replaces a metric.
    const domainCoverage = await computeDomainCoverage(deps.localGraph.db);

    return c.json({
      data: {
        healthScore,
        healthGrade,
        blastRadiusCoverage,
        untestedBlastRadius,
        testedBlastRadius,
        totalBlastRadius,
        bottlenecks,
        riskDistribution,
        riskConcentration,
        communityHealth,
        domainCoverage,
        mostCoupledPair,
        insights,
      },
      _meta: {
        source: "local",
        entities_analyzed: topNodes.length,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  app.get("/durability", async (c) => {
    const start = performance.now();
    const limit = parseLimit(c.req.query("ledger_limit"), 800, 5000);
    const raw = deps.getRecentLedgerEntries(limit);
    const ledgerLike = raw.map((entry) => ({
      prompt: entry.plan_summary ?? "",
      files: extractFilesHint(entry),
      survived: undefined as boolean | undefined,
      riskLevel: undefined as string | undefined,
    }));
    const profiles = computePromptDurabilityProfiles(ledgerLike);
    return c.json({
      data: {
        profiles,
        overall: computeOverallDurability(profiles),
        most_fragile: getMostFragile(profiles, 5),
      },
      _meta: {
        source: "local",
        ledger_entries_sampled: raw.length,
        latency_ms: Math.round((performance.now() - start) * 100) / 100,
      },
    });
  });

  // ── Sprint 8: Health Map ──

  app.get("/health-map", async (c) => {
    if (!deps.localGraph) {
      return c.json({ error: "Graph not available" }, 503);
    }
    const start = performance.now();
    const root = c.req.query("root") || undefined;

    try {
      const { HealthMapData } = await import(
        "../../intelligence/health-map-data.js"
      );
      const healthMap = new HealthMapData(
        deps.localGraph,
        deps.factStore ?? null
      );
      const tree = await healthMap.buildTree(root);
      return c.json({
        data: tree,
        _meta: {
          source: "local",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Health map failed" },
        500
      );
    }
  });

  app.get("/health-map/file", async (c) => {
    if (!deps.localGraph) {
      return c.json({ error: "Graph not available" }, 503);
    }
    const start = performance.now();
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json({ error: "Missing ?path= query parameter" }, 400);
    }

    try {
      const { HealthMapData } = await import(
        "../../intelligence/health-map-data.js"
      );
      const healthMap = new HealthMapData(
        deps.localGraph,
        deps.factStore ?? null
      );
      const node = await healthMap.getFileHealth(filePath);
      if (!node) {
        return c.json({ error: "No entities found for file" }, 404);
      }

      // R4: Recent activity — count ledger entries that touched this file
      // within the last 30 days. Conservative signal of "this file is hot".
      const days = 30;
      const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const entries = deps.getRecentLedgerEntries(500);
      const matchEnds = filePath.toLowerCase();
      let editCount = 0;
      let mostRecentTs: string | undefined;
      const sessions = new Set<string>();
      for (const entry of entries) {
        const ts = Date.parse(entry.ts);
        if (Number.isNaN(ts) || ts < sinceMs) continue;
        const files = extractFilesHint(entry);
        const hit = files.some((f) => f.toLowerCase().endsWith(matchEnds));
        if (!hit) continue;
        editCount += 1;
        sessions.add(entry.session_id);
        if (!mostRecentTs || entry.ts > mostRecentTs) mostRecentTs = entry.ts;
      }

      return c.json({
        data: {
          ...node,
          recent_activity: {
            edit_count: editCount,
            session_count: sessions.size,
            most_recent_ts: mostRecentTs ?? null,
            window_days: days,
          },
        },
        _meta: {
          source: "local",
          latency_ms: Math.round((performance.now() - start) * 100) / 100,
        },
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "File health failed" },
        500
      );
    }
  });

  // Sprint 9.3: Signal delivery stats endpoint
  app.get("/signal-stats", (c) => {
    if (!deps.getSignalStats) {
      return c.json({
        data: { total_delivered: 0, by_type: {}, coverage_pct: 0 },
      });
    }
    return c.json({ data: deps.getSignalStats() });
  });

  return app;
}

function extractFilesHint(entry: LedgerEntry): string[] {
  const files: string[] = [];
  const args = entry.args_summary;
  if (args && typeof args === "object") {
    for (const v of Object.values(args)) {
      if (typeof v === "string" && (v.includes("/") || v.includes("\\"))) {
        files.push(v);
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          if (
            typeof item === "string" &&
            (item.includes("/") || item.includes("\\"))
          ) {
            files.push(item);
          }
        }
      }
    }
  }
  return files;
}
