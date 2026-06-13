/** Envelope from GET /api/intelligence/graph-stats */
export type GraphStatsResponse = {
  data: {
    entityCount: number;
    edgeCount: number;
    fileCount: number;
    ruleCount: number;
    driftCount: number;
    communityCount: number;
    correctionCount: number;
  } | null;
  _meta: { source: string; graph?: string; latency_ms?: number };
};

/** Envelope from GET /api/session/stats */
export type SessionStatsEnvelope = {
  data: {
    tool_calls: number;
    estimated_tokens_saved: number;
    violations_caught: number;
    risk_warnings_issued: number;
    session_started_at: string;
    caught_events: Record<string, number> & { total: number };
    local_mode: unknown;
  };
  _meta: { source: string; latency_ms?: number };
};

/** Payload inside SSE session_stats events (matches stream route JSON). */
export type SessionStatsPayload = {
  tool_calls: number;
  tokens_saved: number;
  violations_caught: number;
  risk_warnings?: number;
  duration_s: number;
  session_events?: Record<string, number>;
  caught_total?: number;
};

/** GET /api/intelligence/search */
export type SearchResponse = {
  data: Array<{
    key: string;
    name: string;
    kind: string;
    file_path: string;
    score: number;
  }>;
  _meta: {
    source: string;
    graph?: string;
    empty_query?: boolean;
    latency_ms?: number;
  };
};

/** GET /api/intelligence/top-entities */
export type TopEntitiesResponse = {
  data: Array<{
    key: string;
    name: string;
    file_path: string;
    fan_in: number;
    fan_out: number;
    degree: number;
    risk_level: string;
    community_label?: string;
  }>;
  _meta: { source: string; graph?: string; latency_ms?: number };
};

export type SlimEntity = {
  key: string;
  name: string;
  kind: string;
  file_path: string;
  fan_in: number;
  fan_out: number;
  risk_level: string;
};

/** GET /api/intelligence/entity/:key */
export type EntityDetailResponse = {
  data: {
    entity: SlimEntity & {
      body: string;
      body_truncated?: boolean;
      start_line: number;
      signature: string;
      community?: number;
    };
    callers: SlimEntity[];
    production_callers: SlimEntity[];
    test_callers: SlimEntity[];
    callees: SlimEntity[];
  } | null;
  _meta: { source: string; not_found?: string; latency_ms?: number };
};

/** GET /api/intelligence/test-coverage/:key */
export type TestCoverageResponse = {
  data: Array<{
    test_key: string;
    test_name: string;
    test_file: string;
    relation: "direct" | "transitive";
    depth: number;
  }>;
  _meta: {
    source: string;
    entity_key: string;
    include_transitive: boolean;
    latency_ms?: number;
  };
};

/** GET /api/intelligence/risk-hotspots */
export type RiskHotspot = {
  key: string;
  name: string;
  file_path: string;
  kind: string;
  fan_in: number;
  fan_out: number;
  degree: number;
  risk_level: string;
  community_label: string;
  test_count: number;
  caller_count: number;
};

export type RiskHotspotsResponse = {
  data: RiskHotspot[];
  _meta: { source: string; graph?: string; latency_ms?: number };
};

/** GET /api/intelligence/insights */
export type InsightCard = {
  id: string;
  severity: "critical" | "warning" | "info" | "positive";
  title: string;
  description: string;
  metric?: number;
  metricLabel?: string;
};

export type Bottleneck = {
  key: string;
  name: string;
  file_path: string;
  kind: string;
  fan_in: number;
  fan_out: number;
  degree: number;
  risk_level: string;
};

export type CommunityHealth = {
  label: string;
  /** SC-D.3: the voted domain name + purity %, when the community is tagged. */
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
};

/** SC-E.3: per-domain entity counts by provenance tier. */
export type DomainCoverage = {
  domain: string;
  comment: number;
  harvested: number;
  propagated: number;
  path: number;
  total: number;
  /** % of the domain's entities tagged from durable (comment/harvested) sources. */
  durablePct: number;
};

export type InsightsResponse = {
  data: {
    healthScore: number;
    healthGrade: string;
    blastRadiusCoverage: number;
    untestedBlastRadius: number;
    testedBlastRadius: number;
    totalBlastRadius: number;
    bottlenecks: Bottleneck[];
    riskDistribution: { high: number; medium: number; low: number };
    riskConcentration: number;
    communityHealth: CommunityHealth[];
    domainCoverage?: DomainCoverage[];
    mostCoupledPair: { from: string; to: string; weight: number } | null;
    insights: InsightCard[];
  } | null;
  _meta: {
    source: string;
    entities_analyzed?: number;
    graph?: string;
    latency_ms?: number;
  };
};

/** GET /api/intelligence/durability */
export type DurabilityResponse = {
  data: {
    profiles: Array<{
      actionType: string;
      targetRisk: string;
      scope: string;
      durability: number;
      sampleCount: number;
      recommendation?: string;
    }>;
    overall: number;
    most_fragile: Array<{
      actionType: string;
      targetRisk: string;
      scope: string;
      durability: number;
      sampleCount: number;
      recommendation?: string;
    }>;
  };
  _meta: { ledger_entries_sampled: number; latency_ms?: number };
};

/** GET /api/intelligence/conventions */
export type ConventionsResponse = {
  data: Array<{
    id: string;
    name: string;
    pattern: string;
    confidence: number;
    observationCount: number;
    detectedAt: string;
    evidence: string[];
  }>;
  _meta: { ledger_entries_sampled: number; latency_ms?: number };
};

/** GET /api/session/ledger */
export type LedgerResponse = {
  data: Array<{
    id: string;
    ts: string;
    tool: string;
    args_summary: Record<string, unknown>;
    result_summary: Record<string, unknown>;
    branch: string;
    session_id: string;
  }>;
  _meta: { count: number; latency_ms?: number };
};

/** GET /api/session/efficiency */
export type EfficiencyResponse = {
  data: {
    totalCalls: number;
    savedTokens: number;
    efficiency: number;
    avgSavingsPerCall?: number;
    deliveredTokens?: number;
    originalTokens?: number;
  } | null;
  _meta: { latency_ms?: number };
};

/** GET /api/session/intents — mirrors IntentGroup */
export type IntentsResponse = {
  data: Array<{
    intentId: string;
    prompt?: string;
    toolCalls: number;
    tokensConsumed: number;
    tokensSaved: number;
    entitiesModified: string[];
    durationMs: number;
    outcome: string;
  }>;
  _meta: { count: number; latency_ms?: number };
};

/** GET /api/intelligence/reading-tour — R2 onboarding tour for unfamiliar repos */
export type ReadingTourStop = {
  rank: number;
  key: string;
  name: string;
  file_path: string;
  kind: string;
  fan_in: number;
  community_label: string;
  why: string;
};

export type ReadingTourResponse = {
  data: {
    stops: ReadingTourStop[];
    estimatedReadingTimeMin: number;
  };
  _meta: { latency_ms?: number };
};

/** GET /api/intelligence/graph-visual — Entity-level node (L2) */
export type GraphVisualNode = {
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
};

/** File-level node for L0/L1 hierarchy */
export type GraphVisualFileNode = {
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
};

/** File-community: cluster of related files */
export type GraphVisualFileCommunity = {
  id: number;
  label: string;
  fileCount: number;
  entityCount: number;
  cohesion: number;
  files: string[];
  inter_edges: Array<{ target: number; weight: number }>;
};

/** Pre-computed positions for all graph levels */
export type GraphPositions = {
  /** L0: community positions keyed by community id */
  communities: Record<number, { x: number; y: number }>;
  /** L1: file positions keyed by filePath */
  files: Record<string, { x: number; y: number }>;
  /** L2: entity positions keyed by entity id */
  entities: Record<string, { x: number; y: number }>;
};

export type GraphVisualResponse = {
  data: {
    /** Entity-level nodes for L2 drill-down */
    nodes: GraphVisualNode[];
    /** Entity-to-entity edges */
    edges: Array<{ from: string; to: string; type: string }>;
    /** File-level nodes for L0/L1 */
    fileNodes: GraphVisualFileNode[];
    /** File-to-file edges (weighted by cross-file call count) */
    fileEdges: Array<{ from: string; to: string; weight: number }>;
    /** File-level communities */
    fileCommunities: GraphVisualFileCommunity[];
    /** Class-to-class edges (weighted by cross-class method calls) */
    classEdges: Array<{
      from: string;
      to: string;
      type: string;
      weight: number;
    }>;
    /** Server-computed deterministic positions */
    positions: GraphPositions;
  };
  _meta: {
    source: string;
    view_mode: "flat" | "file-clusters" | "hierarchical";
    node_count: number;
    edge_count: number;
    file_count: number;
    file_edge_count: number;
    class_edge_count?: number;
    collapsed_count?: number;
    total_entities?: number;
    latency_ms?: number;
  };
};

/** GET /api/system/config */
export type SystemConfigEnvelope = {
  data: {
    repo_config: Record<string, unknown>;
    ide: string;
    skills_installed: string[];
  };
  _meta: { latency_ms?: number };
};

/** GET /api/system/status */
export type SystemStatusEnvelope = {
  data: {
    status: string;
    pid: number;
    uptime_s: number;
    mode: string;
    dashboard_port: number;
    cwd: string;
    ide: string;
    graph: { entities: number; edges: number; rules: number };
    session: {
      tool_calls: number;
      tokens_saved: number;
      violations_caught: number;
      started_at: string;
    };
    auth?: { line: string; badge: string } | null;
    /** Auto-update panel (server/routes/system.ts → updateStatusPanel + line). */
    update?: {
      current: string;
      latest: string | null;
      kind: string;
      status:
        | "disabled"
        | "up-to-date"
        | "available"
        | "pending"
        | "rolled-back";
      policy: "auto" | "notify" | "off";
      manager: string;
      mode: "self_upgradable" | "notify_only";
      upgradeCommand: string | null;
      lastCheckedAt: number | null;
      pendingVersion: string | null;
      line: string;
    } | null;
  };
  _meta: { latency_ms?: number };
};
