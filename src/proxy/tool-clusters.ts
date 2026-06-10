/**
 * Semantic Tool Clusters — groups tools by task domain.
 *
 * When agents call tools/list, we return ALL tools (MCP spec requires it)
 * but REORDER them so the most relevant cluster appears first. Agents
 * tend to use tools listed earlier — reordering is a soft adoption boost.
 *
 * Based on RAG-MCP research: presenting relevant subset first → 3x accuracy.
 * We can't filter (agents may need any tool) but we CAN prioritize.
 */

export interface ToolCluster {
  /** Cluster identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Tool names belonging to this cluster (ordered by importance within cluster). */
  tools: string[];
  /** Keywords that trigger this cluster's priority boost. */
  triggerKeywords: string[];
}

/**
 * Semantic tool clusters — ordered from most to least commonly needed.
 * Default ordering (no context): navigation first, then file-access, quality, persistence, shell.
 */
export const TOOL_CLUSTERS: ToolCluster[] = [
  {
    id: "navigation",
    name: "Code Navigation",
    tools: ["search_code", "get_references"],
    triggerKeywords: [
      "find",
      "search",
      "where",
      "who calls",
      "callers",
      "callees",
      "references",
      "imports",
      "depends",
      "usage",
    ],
  },
  {
    id: "file-access",
    name: "File Access",
    tools: ["file_outline", "file_read"],
    triggerKeywords: [
      "read",
      "file",
      "outline",
      "structure",
      "show me",
      "open",
      "look at",
    ],
  },
  {
    id: "persistence",
    name: "Persistent Intelligence",
    // unerr_remember is hidden (2026-06): user rules are hook-captured, agent
    // notes ride the `unerr-save:` sentinel. unerr_track({op:'fact'|'recall'})
    // is the advertised persistence surface this cluster boosts.
    tools: ["unerr_track"],
    triggerKeywords: [
      "remember",
      "store",
      "always",
      "from now on",
      "hold",
      "keep in mind",
      "note that",
      "fact",
      "convention",
      "anti-pattern",
      "record",
      "recall",
    ],
  },
  {
    id: "web",
    name: "Web Fetch",
    tools: ["fetch_url"],
    triggerKeywords: [
      "fetch",
      "url",
      "webpage",
      "web page",
      "http",
      "https",
      "scrape",
      "docs at",
      "documentation at",
      "blog",
      "article",
    ],
  },
];

/**
 * Map from tool name → cluster id for fast lookup.
 */
const TOOL_TO_CLUSTER: Map<string, string> = new Map();
for (const cluster of TOOL_CLUSTERS) {
  for (const tool of cluster.tools) {
    TOOL_TO_CLUSTER.set(tool, cluster.id);
  }
}

/**
 * Get the cluster ID for a tool name.
 */
export function getToolCluster(toolName: string): string | undefined {
  return TOOL_TO_CLUSTER.get(toolName);
}

/**
 * Recent tool usage tracker — determines which clusters are "hot".
 *
 * Tracks last N tool calls with timestamps. Clusters with recent calls
 * get a priority boost in tools/list ordering.
 */
export class ToolUsageTracker {
  /** Ring buffer of recent tool calls: [toolName, timestamp]. */
  private history: Array<{ tool: string; ts: number }> = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 50) {
    this.maxHistory = maxHistory;
  }

  /**
   * Record a tool call.
   */
  record(toolName: string): void {
    this.history.push({ tool: toolName, ts: Date.now() });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Get cluster priority scores based on recent usage.
   * Higher score = more recently/frequently used cluster.
   *
   * Scoring: each tool call contributes 1/(age_in_calls + 1) to its cluster.
   * Recent calls score higher than older ones.
   */
  getClusterScores(): Map<string, number> {
    const scores = new Map<string, number>();

    const len = this.history.length;
    for (let i = 0; i < len; i++) {
      const entry = this.history[i]!;
      const clusterId = TOOL_TO_CLUSTER.get(entry.tool);
      if (!clusterId) continue;

      // Recency weight: more recent = higher weight
      const recencyWeight = 1 / (len - i);
      scores.set(clusterId, (scores.get(clusterId) ?? 0) + recencyWeight);
    }

    return scores;
  }

  /**
   * Get the number of recorded tool calls.
   */
  getCallCount(): number {
    return this.history.length;
  }

  /**
   * Recent tool names in call order (oldest→newest). Used by Sprint-0 turn
   * telemetry (histogram + recon-pattern detection). Returns a copy.
   */
  getRecentTools(): string[] {
    return this.history.map((e) => e.tool);
  }

  /**
   * Get the most recently used cluster ID, or null if no history.
   */
  getMostRecentCluster(): string | null {
    if (this.history.length === 0) return null;
    const lastEntry = this.history[this.history.length - 1];
    if (!lastEntry) return null;
    const lastTool = lastEntry.tool;
    return TOOL_TO_CLUSTER.get(lastTool) ?? null;
  }
}

/**
 * Reorder tool definitions by cluster priority.
 *
 * All tools are always returned (MCP spec compliance). The order changes
 * based on which clusters scored highest from recent usage.
 *
 * @param tools - Original tool definitions array
 * @param tracker - Usage tracker (null = use default order)
 * @returns Reordered tool definitions (same tools, different order)
 */
export function reorderToolsByCluster<T extends { name: string }>(
  tools: readonly T[],
  tracker: ToolUsageTracker | null
): T[] {
  if (!tracker || tracker.getCallCount() === 0) {
    // No usage data — use default cluster order
    return reorderByDefaultClusters(tools);
  }

  const scores = tracker.getClusterScores();

  // Sort clusters by score (descending), keeping default order for unscored
  const sortedClusterIds = TOOL_CLUSTERS.map((c) => c.id).sort((a, b) => {
    const scoreA = scores.get(a) ?? 0;
    const scoreB = scores.get(b) ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    // Stable: preserve default order for ties
    return (
      TOOL_CLUSTERS.findIndex((c) => c.id === a) -
      TOOL_CLUSTERS.findIndex((c) => c.id === b)
    );
  });

  // Build ordered tool list: clustered tools first (in priority order), unclustered tools last
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const result: T[] = [];
  const added = new Set<string>();

  for (const clusterId of sortedClusterIds) {
    const cluster = TOOL_CLUSTERS.find((c) => c.id === clusterId);
    if (!cluster) continue;
    for (const toolName of cluster.tools) {
      const tool = toolMap.get(toolName);
      if (tool && !added.has(toolName)) {
        result.push(tool);
        added.add(toolName);
      }
    }
  }

  // Append any tools not in any cluster (future-proofing)
  for (const tool of tools) {
    if (!added.has(tool.name)) {
      result.push(tool);
      added.add(tool.name);
    }
  }

  return result;
}

/**
 * Reorder tools by default cluster ordering (no usage data).
 */
function reorderByDefaultClusters<T extends { name: string }>(
  tools: readonly T[]
): T[] {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const result: T[] = [];
  const added = new Set<string>();

  for (const cluster of TOOL_CLUSTERS) {
    for (const toolName of cluster.tools) {
      const tool = toolMap.get(toolName);
      if (tool && !added.has(toolName)) {
        result.push(tool);
        added.add(toolName);
      }
    }
  }

  for (const tool of tools) {
    if (!added.has(tool.name)) {
      result.push(tool);
      added.add(tool.name);
    }
  }

  return result;
}
