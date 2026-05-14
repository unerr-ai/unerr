import { describe, expect, it } from "vitest";
import {
  extractChains,
  getEntityHistory,
  getRevertPatterns,
  getSessionTimeline,
} from "../tracking/ledger-chains.js";
import type { LedgerEntry } from "../tracking/shadow-ledger.js";

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    tool: "get_function",
    args_summary: {},
    result_summary: {},
    branch: "main",
    head_sha: "abc123",
    session_id: "sess-001",
    correlation_id: null,
    ...overrides,
  };
}

describe("ledger-chains", () => {
  describe("extractChains", () => {
    it("groups entries by correlation_id into chains", () => {
      const root = makeEntry({ id: "root-1", correlation_id: null });
      const child1 = makeEntry({ id: "c1", correlation_id: "root-1" });
      const child2 = makeEntry({ id: "c2", correlation_id: "root-1" });
      const standalone = makeEntry({ id: "root-2", correlation_id: null });

      const chains = extractChains([root, child1, child2, standalone]);
      expect(chains.length).toBe(2);

      const mainChain = chains.find((c) => c.root_id === "root-1");
      expect(mainChain).toBeDefined();
      expect(mainChain!.entries.length).toBe(3);
    });

    it("extracts entities from chain entries", () => {
      const root = makeEntry({
        id: "r",
        correlation_id: null,
        args_summary: { key: "src/auth.ts::login" },
      });
      const child = makeEntry({
        id: "c",
        correlation_id: "r",
        args_summary: { file_path: "src/auth.ts" },
      });

      const chains = extractChains([root, child]);
      expect(chains[0]!.entities_touched).toContain("src/auth.ts::login");
      expect(chains[0]!.entities_touched).toContain("src/auth.ts");
    });

    it("classifies reverted chains", () => {
      const root = makeEntry({
        id: "r",
        correlation_id: null,
        tool: "get_function",
      });
      const revert = makeEntry({
        id: "c",
        correlation_id: "r",
        tool: "unerr_revert_to_working_state",
      });

      const chains = extractChains([root, revert]);
      expect(chains[0]!.outcome).toBe("reverted");
    });

    it("classifies modified chains (sync_local_diff present)", () => {
      const root = makeEntry({
        id: "r",
        correlation_id: null,
        tool: "get_function",
      });
      const sync = makeEntry({
        id: "c",
        correlation_id: "r",
        tool: "sync_local_diff",
      });

      const chains = extractChains([root, sync]);
      expect(chains[0]!.outcome).toBe("modified");
    });
  });

  describe("getEntityHistory", () => {
    it("returns chains that touched a specific entity", () => {
      const entries = [
        makeEntry({
          id: "r1",
          correlation_id: null,
          args_summary: { key: "src/proxy.ts::startProxy" },
        }),
        makeEntry({
          id: "r2",
          correlation_id: null,
          args_summary: { key: "src/auth.ts::login" },
        }),
      ];

      const history = getEntityHistory(entries, "src/proxy.ts");
      expect(history.length).toBe(1);
      expect(history[0]!.entities_touched).toContain(
        "src/proxy.ts::startProxy",
      );
    });

    it("limits results", () => {
      const entries = Array.from({ length: 30 }, (_, i) =>
        makeEntry({
          id: `r${i}`,
          correlation_id: null,
          args_summary: { file_path: "src/hot.ts" },
        }),
      );

      const history = getEntityHistory(entries, "src/hot.ts", 5);
      expect(history.length).toBe(5);
    });
  });

  describe("getRevertPatterns", () => {
    it("detects tool sequences that lead to reverts", () => {
      const entries: LedgerEntry[] = [];

      // Create 3 chains with same tool sequence, 2 reverted
      for (let i = 0; i < 3; i++) {
        const rootId = `root-${i}`;
        entries.push(
          makeEntry({ id: rootId, correlation_id: null, tool: "get_function" }),
          makeEntry({
            id: `c${i}-1`,
            correlation_id: rootId,
            tool: "file_read",
          }),
          makeEntry({
            id: `c${i}-2`,
            correlation_id: rootId,
            tool: i < 2 ? "unerr_revert_to_working_state" : "get_callers",
          }),
        );
      }

      const patterns = getRevertPatterns(entries, 2);
      expect(patterns.length).toBeGreaterThan(0);
      const mainPattern = patterns.find((p) =>
        p.tool_sequence.includes("get_function"),
      );
      expect(mainPattern).toBeDefined();
      expect(mainPattern!.revert_rate).toBeGreaterThan(0);
    });

    it("returns empty when no reverts", () => {
      const entries = [
        makeEntry({ id: "r1", correlation_id: null, tool: "get_function" }),
        makeEntry({ id: "r2", correlation_id: null, tool: "get_callers" }),
      ];

      const patterns = getRevertPatterns(entries);
      expect(patterns.length).toBe(0);
    });
  });

  describe("getSessionTimeline", () => {
    it("groups entries by session_id", () => {
      const entries = [
        makeEntry({ session_id: "s1", tool: "get_function" }),
        makeEntry({ session_id: "s1", tool: "get_callers" }),
        makeEntry({ session_id: "s2", tool: "search_code" }),
      ];

      const timeline = getSessionTimeline(entries);
      expect(timeline.length).toBe(2);

      const s1 = timeline.find((s) => s.session_id === "s1");
      expect(s1).toBeDefined();
      expect(s1!.tool_calls).toBe(2);
      expect(s1!.tools_used["get_function"]).toBe(1);
    });

    it("counts facts recorded", () => {
      const entries = [
        makeEntry({ session_id: "s1", tool: "record_fact" }),
        makeEntry({ session_id: "s1", tool: "record_fact" }),
        makeEntry({ session_id: "s1", tool: "get_function" }),
      ];

      const timeline = getSessionTimeline(entries);
      expect(timeline[0]!.facts_recorded).toBe(2);
    });

    it("respects count limit", () => {
      const entries = Array.from({ length: 30 }, (_, i) =>
        makeEntry({ session_id: `s${i}` }),
      );

      const timeline = getSessionTimeline(entries, 3);
      expect(timeline.length).toBe(3);
    });
  });
});
