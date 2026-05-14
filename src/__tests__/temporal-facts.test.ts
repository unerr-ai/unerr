import { beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";
import {
  type CreateFactInput,
  TemporalFactStore,
} from "../intelligence/temporal-facts.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

describe("TemporalFactStore", () => {
  let db: CozoDb;
  let store: TemporalFactStore;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = TemporalFactStore.fromDb(db);
  });

  describe("createFact", () => {
    it("creates a new fact and returns fact_id", async () => {
      const input: CreateFactInput = {
        fact_type: "semantic",
        scope: "project",
        subject: "auth-module",
        content: "The auth module uses JWT tokens for session management",
        source: "agent_explicit",
      };
      const factId = await store.createFact(input);
      expect(factId).toBeDefined();
      expect(factId.length).toBe(36);
    });

    it("deduplicates on (fact_type, scope, subject) match", async () => {
      const input: CreateFactInput = {
        fact_type: "semantic",
        scope: "project",
        subject: "database",
        content: "We use PostgreSQL",
        source: "agent_explicit",
      };
      const id1 = await store.createFact(input);
      const id2 = await store.createFact({
        ...input,
        content: "We use PostgreSQL for all data",
      });
      expect(id2).toBe(id1);
    });

    it("truncates content at 280 characters", async () => {
      const longContent = "x".repeat(500);
      const factId = await store.createFact({
        fact_type: "procedural",
        scope: "project",
        subject: "testing",
        content: longContent,
        source: "agent_explicit",
      });
      expect(factId).toBeDefined();
    });
  });

  describe("convention fact type", () => {
    it("creates and recalls a convention fact with slow decay", async () => {
      const factId = await store.createFact({
        fact_type: "convention",
        scope: "project",
        subject: "api-standards",
        content: "All API handlers must return structured JSON responses",
        source: "agent_explicit",
      });
      expect(factId).toBeDefined();

      const facts = await store.recallByScope("project");
      const convention = facts.find((f) => f.fact_type === "convention");
      expect(convention).toBeDefined();
      expect(convention!.content).toBe(
        "All API handlers must return structured JSON responses",
      );
      expect(convention!.effective_confidence).toBeGreaterThan(0.9);
    });

    it("includes convention in getFactHealth by_type", async () => {
      await store.createFact({
        fact_type: "convention",
        scope: "project",
        subject: "naming",
        content: "Use camelCase for all function names",
        source: "agent_explicit",
      });

      const health = await store.getFactHealth();
      expect(health.by_type.convention).toBe(1);
    });
  });

  describe("recallByScope", () => {
    it("recalls facts matching scope with decay applied", async () => {
      await store.createFact({
        fact_type: "semantic",
        scope: "src/proxy/proxy.ts",
        subject: "proxy",
        content: "The proxy module owns all MCP communication",
        source: "agent_explicit",
      });

      const facts = await store.recallByScope("src/proxy/proxy.ts");
      expect(facts.length).toBe(1);
      expect(facts[0]!.content).toBe(
        "The proxy module owns all MCP communication",
      );
      expect(facts[0]!.effective_confidence).toBeGreaterThan(0);
    });

    it("returns empty array for unknown scope", async () => {
      const facts = await store.recallByScope("nonexistent/file.ts");
      expect(facts).toEqual([]);
    });
  });

  describe("recallBySubject", () => {
    it("recalls facts matching subject", async () => {
      await store.createFact({
        fact_type: "semantic",
        scope: "project",
        subject: "src/auth.ts::login",
        content: "Login function requires rate limiting",
        source: "agent_explicit",
      });

      const facts = await store.recallBySubject("src/auth.ts::login");
      expect(facts.length).toBe(1);
      expect(facts[0]!.subject).toBe("src/auth.ts::login");
    });
  });

  describe("recallNegative", () => {
    it("recalls all negative facts regardless of scope", async () => {
      await store.createFact({
        fact_type: "negative",
        scope: "project",
        subject: "testing",
        content: "Don't mock CozoDB in integration tests",
        source: "negative_knowledge",
      });
      await store.createFact({
        fact_type: "semantic",
        scope: "project",
        subject: "architecture",
        content: "Semantic fact that should not appear",
        source: "agent_explicit",
      });

      const facts = await store.recallNegative();
      expect(facts.length).toBe(1);
      expect(facts[0]!.fact_type).toBe("negative");
    });
  });

  describe("reinforceFact", () => {
    it("increases reinforcement_count", async () => {
      const factId = await store.createFact({
        fact_type: "semantic",
        scope: "src/index.ts",
        subject: "arch",
        content: "Microservices architecture",
        source: "agent_explicit",
      });

      await store.reinforceFact(factId, {
        session_id: "sess-1",
        action: "reinforced",
        timestamp: Date.now(),
      });

      const facts = await store.recallByScope("src/index.ts", 0);
      const fact = facts.find((f) => f.fact_id === factId);
      expect(fact).toBeDefined();
      expect(fact!.reinforcement_count).toBe(2);
    });

    it("increases effective confidence via evidence factor", async () => {
      const factId = await store.createFact({
        fact_type: "semantic",
        scope: "src/util.ts",
        subject: "utils",
        content: "Utility functions are pure",
        source: "convention_detector",
      });

      const before = await store.recallByScope("src/util.ts", 0);
      const confBefore = before[0]!.effective_confidence;

      await store.reinforceFact(factId, {
        session_id: "s2",
        action: "reinforced",
        timestamp: Date.now(),
      });
      await store.reinforceFact(factId, {
        session_id: "s3",
        action: "reinforced",
        timestamp: Date.now(),
      });

      const after = await store.recallByScope("src/util.ts", 0);
      const confAfter = after[0]!.effective_confidence;

      expect(confAfter).toBeGreaterThan(confBefore);
    });
  });

  describe("contradictFact", () => {
    it("halves base_confidence", async () => {
      const factId = await store.createFact({
        fact_type: "semantic",
        scope: "src/db.ts",
        subject: "db",
        content: "We use MySQL",
        source: "agent_explicit",
        base_confidence: 0.9,
      });

      await store.contradictFact(factId, "Actually using PostgreSQL");

      const facts = await store.recallByScope("src/db.ts", 0);
      const fact = facts.find((f) => f.fact_id === factId);
      expect(fact).toBeDefined();
      expect(fact!.base_confidence).toBeCloseTo(0.45, 1);
    });
  });

  describe("getFactHealth", () => {
    it("returns health summary with correct counts", async () => {
      await store.createFact({
        fact_type: "semantic",
        scope: "project",
        subject: "a",
        content: "Fact A",
        source: "agent_explicit",
      });
      await store.createFact({
        fact_type: "negative",
        scope: "project",
        subject: "b",
        content: "Fact B",
        source: "negative_knowledge",
      });

      const health = await store.getFactHealth();
      expect(health.total).toBe(2);
      expect(health.by_type.semantic).toBe(1);
      expect(health.by_type.negative).toBe(1);
      expect(health.avg_confidence).toBeGreaterThan(0);
    });
  });

  describe("pruneDecayed", () => {
    it("removes facts below prune threshold", async () => {
      const factId = await store.createFact({
        fact_type: "semantic",
        scope: "src/old.ts",
        subject: "prune-target",
        content: "Will be contradicted into oblivion",
        source: "agent_explicit",
        base_confidence: 0.1,
      });

      // Contradict multiple times to drive confidence below threshold
      await store.contradictFact(factId, "wrong");
      await store.contradictFact(factId, "still wrong");
      await store.contradictFact(factId, "really wrong");

      // 0.1 * 0.5^3 = 0.0125, evidence_factor = 1/3 = 0.33
      // effective = 0.0125 * 1.0 * 0.33 = 0.004 — well below 0.05
      const pruned = await store.pruneDecayed(0.05);
      expect(pruned).toBe(1);
    });
  });

  describe("recallForFile", () => {
    it("combines scope + subject + negative facts", async () => {
      await store.createFact({
        fact_type: "semantic",
        scope: "src/auth.ts",
        subject: "auth",
        content: "Auth uses bcrypt for password hashing",
        source: "agent_explicit",
      });

      const negId = await store.createFact({
        fact_type: "negative",
        scope: "project",
        subject: "security",
        content: "Never store passwords in plain text",
        source: "negative_knowledge",
        base_confidence: 0.95,
      });
      // Reinforce to push evidence_factor above threshold boundary
      await store.reinforceFact(negId, {
        session_id: "s2",
        action: "reinforced",
        timestamp: Date.now(),
      });
      await store.reinforceFact(negId, {
        session_id: "s3",
        action: "reinforced",
        timestamp: Date.now(),
      });

      await store.createFact({
        fact_type: "procedural",
        scope: "src/unrelated.ts",
        subject: "unrelated",
        content: "This should not appear",
        source: "session_analysis",
      });

      const facts = await store.recallForFile("src/auth.ts", ["auth"]);
      expect(facts.length).toBe(2);
      const types = facts.map((f) => f.fact_type);
      expect(types).toContain("semantic");
      expect(types).toContain("negative");
    });
  });

  describe("recordInteraction", () => {
    it("records entity interaction without error", async () => {
      await expect(
        store.recordInteraction(
          "src/auth.ts::login",
          "session-abc",
          "read",
          "get_function",
          "success",
        ),
      ).resolves.not.toThrow();
    });
  });
});
