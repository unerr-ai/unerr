// @ts-nocheck — test file
/**
 * SessionBriefBuilder tests — structured session brief generation.
 */

import { describe, expect, it, vi } from "vitest";
import { SessionBriefBuilder } from "../intelligence/session-brief-builder.js";

function createMockGraph(
  conventions: Array<{
    name: string;
    kind: string;
    frequency: number;
    confidence: number;
    adherence_rate: number;
  }> = [],
) {
  return {
    getConventions: vi.fn(() => Promise.resolve(conventions)),
  };
}

function createMockFactStore(
  facts: Array<{
    fact_id: string;
    fact_type: string;
    content: string;
    effective_confidence: number;
    source: string;
  }> = [],
) {
  return {
    recallByScope: vi.fn(() => Promise.resolve(facts)),
  };
}

describe("SessionBriefBuilder", () => {
  describe("build", () => {
    it("returns greeting with health grade when stats available", async () => {
      const builder = new SessionBriefBuilder(
        null,
        null,
        { entities: 100, edges: 200, rules: 10 },
        "A",
      );
      const brief = await builder.build();
      expect(brief.greeting).toContain("100 entities");
      expect(brief.greeting).toContain("scores A");
    });

    it("returns fallback greeting when no stats", async () => {
      const builder = new SessionBriefBuilder(null, null, null, null);
      const brief = await builder.build();
      expect(brief.greeting).toContain("proxy ready");
    });

    it("includes inter_session_changes from resume context", async () => {
      const builder = new SessionBriefBuilder(null, null, null, null);
      const brief = await builder.build({
        summary: "Last session: 10 tool calls",
        filesModified: ["src/a.ts", "src/b.ts"],
        incompleteEntities: [],
      });
      expect(brief.inter_session_changes).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("includes unfinished_work from resume context", async () => {
      const builder = new SessionBriefBuilder(null, null, null, null);
      const brief = await builder.build({
        summary: "Last session",
        filesModified: [],
        incompleteEntities: ["src/wip.ts"],
      });
      expect(brief.unfinished_work).toEqual(["src/wip.ts"]);
    });

    it("omits inter_session_changes when empty", async () => {
      const builder = new SessionBriefBuilder(null, null, null, null);
      const brief = await builder.build({
        summary: "Last session",
        filesModified: [],
        incompleteEntities: [],
      });
      expect(brief.inter_session_changes).toBeUndefined();
      expect(brief.unfinished_work).toBeUndefined();
    });

    it("includes key_facts from fact store", async () => {
      const factStore = createMockFactStore([
        {
          fact_id: "1",
          fact_type: "semantic",
          content: "Important fact",
          effective_confidence: 0.9,
          source: "auto",
        },
        {
          fact_id: "2",
          fact_type: "semantic",
          content: "Another fact",
          effective_confidence: 0.7,
          source: "auto",
        },
      ]);
      const builder = new SessionBriefBuilder(
        null,
        factStore as any,
        null,
        null,
      );
      const brief = await builder.build();
      expect(brief.key_facts).toHaveLength(2);
      expect(brief.key_facts[0]).toBe("Important fact");
    });

    it("caps key_facts at 3", async () => {
      const factStore = createMockFactStore([
        {
          fact_id: "1",
          fact_type: "semantic",
          content: "Fact 1",
          effective_confidence: 0.9,
          source: "auto",
        },
        {
          fact_id: "2",
          fact_type: "semantic",
          content: "Fact 2",
          effective_confidence: 0.8,
          source: "auto",
        },
        {
          fact_id: "3",
          fact_type: "semantic",
          content: "Fact 3",
          effective_confidence: 0.7,
          source: "auto",
        },
        {
          fact_id: "4",
          fact_type: "semantic",
          content: "Fact 4",
          effective_confidence: 0.6,
          source: "auto",
        },
      ]);
      const builder = new SessionBriefBuilder(
        null,
        factStore as any,
        null,
        null,
      );
      const brief = await builder.build();
      expect(brief.key_facts).toHaveLength(3);
    });

    it("includes convention_summary from graph", async () => {
      const graph = createMockGraph([
        {
          name: "camelCase",
          kind: "function",
          frequency: 50,
          confidence: 0.9,
          adherence_rate: 90,
        },
        {
          name: "PascalCase",
          kind: "class",
          frequency: 20,
          confidence: 0.8,
          adherence_rate: 80,
        },
      ]);
      const builder = new SessionBriefBuilder(graph as any, null, null, null);
      const brief = await builder.build();
      expect(brief.convention_summary).toContain("2 conventions");
      expect(brief.convention_summary).toContain("85%");
    });

    it("includes intelligence_health with entity count and facts", async () => {
      const factStore = createMockFactStore([
        {
          fact_id: "1",
          fact_type: "semantic",
          content: "Fact",
          effective_confidence: 0.9,
          source: "auto",
        },
      ]);
      const graph = createMockGraph([
        {
          name: "camelCase",
          kind: "function",
          frequency: 50,
          confidence: 0.9,
          adherence_rate: 90,
        },
      ]);
      const builder = new SessionBriefBuilder(
        graph as any,
        factStore as any,
        { entities: 42, edges: 100, rules: 5 },
        "B",
      );
      const brief = await builder.build();
      expect(brief.intelligence_health).toContain("42 entities");
      expect(brief.intelligence_health).toContain("1 facts");
      expect(brief.intelligence_health).toContain("1 conventions");
    });

    it("handles null resume context gracefully", async () => {
      const builder = new SessionBriefBuilder(null, null, null, null);
      const brief = await builder.build(null);
      expect(brief.greeting).toBeDefined();
      expect(brief.inter_session_changes).toBeUndefined();
      expect(brief.unfinished_work).toBeUndefined();
    });
  });

  describe("greeting variants", () => {
    it("grade B includes 'could improve'", async () => {
      const builder = new SessionBriefBuilder(
        null,
        null,
        { entities: 50, edges: 80, rules: 5 },
        "B",
      );
      const brief = await builder.build();
      expect(brief.greeting).toContain("could improve");
    });

    it("grade C includes 'structural issues'", async () => {
      const builder = new SessionBriefBuilder(
        null,
        null,
        { entities: 50, edges: 80, rules: 5 },
        "C",
      );
      const brief = await builder.build();
      expect(brief.greeting).toContain("Structural issues");
    });

    it("grade D includes 'Warning'", async () => {
      const builder = new SessionBriefBuilder(
        null,
        null,
        { entities: 50, edges: 80, rules: 5 },
        "D",
      );
      const brief = await builder.build();
      expect(brief.greeting).toContain("Warning");
    });
  });
});
