/**
 * S7: Semantic Tool Clustering tests.
 *
 * Tests: cluster definitions, usage tracking, tool reordering.
 */

import { describe, expect, it } from "vitest";
import {
  TOOL_CLUSTERS,
  ToolUsageTracker,
  getToolCluster,
  reorderToolsByCluster,
} from "../proxy/tool-clusters.js";

// ── Cluster Definitions ──────────────────────────────────────────────

describe("TOOL_CLUSTERS", () => {
  it("has 4 semantic clusters", () => {
    // After the token-overhead deletion the catalog is 9 tools; the survivors
    // cluster into navigation, file-access, persistence, web. The old
    // quality / structural / session-narrative / recovery clusters are gone
    // (their tools were removed from the advertised catalog).
    expect(TOOL_CLUSTERS).toHaveLength(4);
  });

  it("clusters have unique IDs", () => {
    const ids = TOOL_CLUSTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all tools appear in exactly one cluster", () => {
    const toolCounts = new Map<string, number>();
    for (const cluster of TOOL_CLUSTERS) {
      for (const tool of cluster.tools) {
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      }
    }
    for (const [tool, count] of toolCounts) {
      expect(count, `${tool} appears in ${count} clusters`).toBe(1);
    }
  });

  it("navigation cluster is ordered first (most commonly needed)", () => {
    // Clusters are ordered most→least commonly needed (see TOOL_CLUSTERS doc
    // comment), not by tool count. Navigation must lead; tool counts vary as
    // clusters grow (e.g. session-narrative gained turn_summary).
    expect(TOOL_CLUSTERS[0]?.id).toBe("navigation");
  });

  it("each cluster has trigger keywords", () => {
    for (const cluster of TOOL_CLUSTERS) {
      expect(cluster.triggerKeywords.length).toBeGreaterThan(0);
    }
  });
});

// ── getToolCluster ───────────────────────────────────────────────────

describe("getToolCluster", () => {
  it("maps search_code to navigation", () => {
    expect(getToolCluster("search_code")).toBe("navigation");
  });

  it("maps file_outline to file-access", () => {
    expect(getToolCluster("file_outline")).toBe("file-access");
  });

  it("maps get_references to navigation", () => {
    expect(getToolCluster("get_references")).toBe("navigation");
  });

  it("maps file_read to file-access", () => {
    expect(getToolCluster("file_read")).toBe("file-access");
  });

  it("maps unerr_track to persistence", () => {
    // unerr_remember left the catalog (2026-06): user rules are hook-captured,
    // agent notes ride the `unerr-save:` sentinel. unerr_track({op:'fact'|
    // 'recall'}) is the advertised persistence surface the cluster boosts.
    expect(getToolCluster("unerr_track")).toBe("persistence");
    expect(getToolCluster("unerr_remember")).toBeUndefined();
  });

  it("maps fetch_url to web", () => {
    expect(getToolCluster("fetch_url")).toBe("web");
  });

  it("returns undefined for removed (non-catalog) tools", () => {
    // record_fact / recall_facts / get_test_coverage were dropped from the
    // advertised catalog; they belong to no cluster.
    expect(getToolCluster("record_fact")).toBeUndefined();
    expect(getToolCluster("recall_facts")).toBeUndefined();
    expect(getToolCluster("get_test_coverage")).toBeUndefined();
  });

  it("returns undefined for unknown tool", () => {
    expect(getToolCluster("unknown_tool")).toBeUndefined();
  });
});

// ── ToolUsageTracker ─────────────────────────────────────────────────

describe("ToolUsageTracker", () => {
  it("starts with zero call count", () => {
    const tracker = new ToolUsageTracker();
    expect(tracker.getCallCount()).toBe(0);
  });

  it("records tool calls", () => {
    const tracker = new ToolUsageTracker();
    tracker.record("search_code");
    tracker.record("get_entity");
    expect(tracker.getCallCount()).toBe(2);
  });

  it("tracks most recent cluster", () => {
    const tracker = new ToolUsageTracker();
    tracker.record("search_code");
    expect(tracker.getMostRecentCluster()).toBe("navigation");

    tracker.record("file_outline");
    expect(tracker.getMostRecentCluster()).toBe("file-access");
  });

  it("returns null for most recent cluster with no history", () => {
    const tracker = new ToolUsageTracker();
    expect(tracker.getMostRecentCluster()).toBeNull();
  });

  it("returns null for unknown tools in most recent cluster", () => {
    const tracker = new ToolUsageTracker();
    tracker.record("unknown_tool");
    expect(tracker.getMostRecentCluster()).toBeNull();
  });

  it("produces cluster scores with recency weighting", () => {
    const tracker = new ToolUsageTracker();
    tracker.record("search_code");
    tracker.record("file_outline");
    tracker.record("search_code");

    const scores = tracker.getClusterScores();
    // navigation should score higher (2 calls, more recent)
    expect(scores.get("navigation")).toBeGreaterThan(0);
    expect(scores.get("file-access")).toBeGreaterThan(0);
    expect(scores.get("navigation")!).toBeGreaterThan(
      scores.get("file-access")!
    );
  });

  it("respects maxHistory limit", () => {
    const tracker = new ToolUsageTracker(3);
    tracker.record("search_code");
    tracker.record("file_outline");
    tracker.record("get_rules");
    tracker.record("record_fact");
    expect(tracker.getCallCount()).toBe(3); // oldest dropped
  });
});

// ── reorderToolsByCluster ────────────────────────────────────────────

describe("reorderToolsByCluster", () => {
  const mockTools = [
    { name: "get_entity" },
    { name: "file_outline" },
    { name: "get_rules" },
    { name: "record_fact" },
    { name: "unerr_mark_working" },
    { name: "search_code" },
    { name: "file_read" },
  ];

  it("returns all tools (never filters)", () => {
    const tracker = new ToolUsageTracker();
    const result = reorderToolsByCluster(mockTools, tracker);
    expect(result).toHaveLength(mockTools.length);
  });

  it("returns same tools with null tracker", () => {
    const result = reorderToolsByCluster(mockTools, null);
    expect(result).toHaveLength(mockTools.length);
    // All original tools present
    const names = result.map((t) => t.name);
    for (const tool of mockTools) {
      expect(names).toContain(tool.name);
    }
  });

  it("uses default cluster order with no usage data", () => {
    const tracker = new ToolUsageTracker();
    const result = reorderToolsByCluster(mockTools, tracker);
    const names = result.map((t) => t.name);
    // Navigation cluster tools should come first (default order)
    expect(names.indexOf("search_code")).toBeLessThan(
      names.indexOf("file_outline")
    );
    expect(names.indexOf("search_code")).toBeLessThan(
      names.indexOf("get_rules")
    );
  });

  it("prioritizes recently-used cluster", () => {
    const tracker = new ToolUsageTracker();
    // Use file-access tools heavily
    tracker.record("file_outline");
    tracker.record("file_read");
    tracker.record("file_outline");

    const result = reorderToolsByCluster(mockTools, tracker);
    const names = result.map((t) => t.name);
    // file-access tools should now come before navigation
    expect(names.indexOf("file_outline")).toBeLessThan(
      names.indexOf("search_code")
    );
  });

  it("includes unclustered tools at the end", () => {
    const toolsWithExtra = [
      ...mockTools,
      { name: "custom_tool_not_in_cluster" },
    ];
    const result = reorderToolsByCluster(toolsWithExtra, null);
    const names = result.map((t) => t.name);
    expect(names[names.length - 1]).toBe("custom_tool_not_in_cluster");
  });

  it("preserves tool object references", () => {
    const tools = [
      { name: "search_code", description: "search desc" },
      { name: "file_outline", description: "outline desc" },
    ];
    const result = reorderToolsByCluster(tools, null);
    const searchTool = result.find((t) => t.name === "search_code");
    expect(searchTool).toBe(tools[0]); // Same reference, not copy
  });
});
