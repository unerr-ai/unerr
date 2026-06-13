import { describe, expect, it } from "vitest";

import {
  type IdeConfigResult,
  type ToolCapAnalysis,
  analyzeToolCaps,
} from "../config/ide-mcp-inspector.js";

function makeConfig(
  agentId: string,
  servers: { name: string; toolCount?: number }[],
  agentName = "Cursor"
): IdeConfigResult {
  return {
    agentId,
    agentName,
    configPath: "/fake/.cursor/mcp.json",
    relativeConfigPath: ".cursor/mcp.json",
    isUnerrAlreadyRouter: false,
    servers: servers.map((s) => ({
      name: s.name,
      entry: { command: "npx", args: [] },
      toolCount: s.toolCount ?? null,
    })),
  };
}

describe("Cursor 40-tool cap detection", () => {
  // ── Basic cap detection ────────────────────────────────────────

  it("detects when Cursor config exceeds 40-tool cap", () => {
    const configs = [
      makeConfig("cursor", [
        { name: "github", toolCount: 20 },
        { name: "postgres", toolCount: 15 },
        { name: "slack", toolCount: 10 },
      ]),
    ];

    const results = analyzeToolCaps(configs);
    expect(results).toHaveLength(1);
    expect(results[0]!.exceedsCap).toBe(true);
    expect(results[0]!.totalTools).toBe(45);
    expect(results[0]!.cap).toBe(40);
    expect(results[0]!.droppedCount).toBe(5);
  });

  it("identifies which servers get dropped", () => {
    const configs = [
      makeConfig("cursor", [
        { name: "github", toolCount: 25 },
        { name: "postgres", toolCount: 10 },
        { name: "slack", toolCount: 10 },
        { name: "sentry", toolCount: 8 },
      ]),
    ];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.exceedsCap).toBe(true);
    expect(results[0]!.totalTools).toBe(53);
    expect(results[0]!.droppedServers.length).toBeGreaterThan(0);
    expect(results[0]!.droppedServers).toContain("sentry");
  });

  it("does not flag when under cap", () => {
    const configs = [
      makeConfig("cursor", [
        { name: "github", toolCount: 20 },
        { name: "postgres", toolCount: 15 },
      ]),
    ];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.exceedsCap).toBe(false);
    expect(results[0]!.droppedCount).toBe(0);
    expect(results[0]!.droppedServers).toEqual([]);
  });

  it("reports exact cap (40) for Cursor", () => {
    const configs = [makeConfig("cursor", [{ name: "single", toolCount: 41 }])];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.cap).toBe(40);
  });

  // ── Non-Cursor agents ──────────────────────────────────────────

  it("returns null cap for unknown agents", () => {
    const configs = [
      makeConfig(
        "claude-code",
        [{ name: "github", toolCount: 100 }],
        "Claude Code"
      ),
    ];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.cap).toBeNull();
    expect(results[0]!.exceedsCap).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it("handles exactly 40 tools (not exceeding)", () => {
    const configs = [
      makeConfig("cursor", [
        { name: "github", toolCount: 20 },
        { name: "postgres", toolCount: 20 },
      ]),
    ];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.exceedsCap).toBe(false);
    expect(results[0]!.totalTools).toBe(40);
  });

  it("handles empty server list", () => {
    const configs = [makeConfig("cursor", [])];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.totalTools).toBe(0);
    expect(results[0]!.exceedsCap).toBe(false);
  });

  it("handles multiple configs (multi-IDE)", () => {
    const configs = [
      makeConfig("cursor", [
        { name: "github", toolCount: 25 },
        { name: "postgres", toolCount: 20 },
      ]),
      makeConfig(
        "claude-code",
        [{ name: "github", toolCount: 100 }],
        "Claude Code"
      ),
    ];

    const results = analyzeToolCaps(configs);
    expect(results).toHaveLength(2);
    expect(results[0]!.exceedsCap).toBe(true);
    expect(results[1]!.exceedsCap).toBe(false);
  });

  // ── Dropped server ordering ────────────────────────────────────

  it("drops servers in config order (last ones overflow)", () => {
    const configs = [
      makeConfig("cursor", [
        { name: "primary", toolCount: 35 },
        { name: "secondary", toolCount: 5 },
        { name: "tertiary", toolCount: 10 },
      ]),
    ];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.droppedServers).toContain("tertiary");
  });

  // ── Large config stress test ───────────────────────────────────

  it("handles large number of servers", () => {
    const servers = Array.from({ length: 20 }, (_, i) => ({
      name: `server-${i}`,
      toolCount: 5,
    }));
    const configs = [makeConfig("cursor", servers)];

    const results = analyzeToolCaps(configs);
    expect(results[0]!.totalTools).toBe(100);
    expect(results[0]!.exceedsCap).toBe(true);
    expect(results[0]!.droppedCount).toBe(60);
    expect(results[0]!.droppedServers.length).toBeGreaterThan(0);
  });
});
