import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import {
  type CausalBridgeEvent,
  generateFromCausalBridge,
  generateFromConventions,
  generateFromNegativeKnowledge,
  generateFromSessionAnalysis,
} from "../intelligence/fact-generator.js";
import { initFactsSchema } from "../intelligence/facts-schema.js";
import type { DetectedConvention } from "../intelligence/local-convention-detector.js";
import type { CorrectionEntry } from "../intelligence/negative-knowledge.js";
import { TemporalFactStore } from "../intelligence/temporal-facts.js";
import type { SessionSummaryRecord } from "../tracking/session-summary-writer.js";

async function createTestDb(): Promise<CozoDb> {
  const cozoModule = await import("cozo-node");
  const CozoDbConstructor = (
    cozoModule as { default?: { CozoDb: unknown }; CozoDb?: unknown }
  ).default
    ? (cozoModule as { default: { CozoDb: unknown } }).default.CozoDb
    : (cozoModule as { CozoDb: unknown }).CozoDb;
  return new (CozoDbConstructor as any)("mem", "") as CozoDb;
}

function makeSessionRecord(
  overrides: Partial<SessionSummaryRecord> = {},
): SessionSummaryRecord {
  return {
    session_id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    written_at: new Date().toISOString(),
    started_at: new Date(Date.now() - 3600000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 3600000,
    tool_calls: 20,
    chains: 5,
    files_modified: ["src/proxy.ts", "src/auth.ts"],
    entities_touched: ["src/proxy.ts::startProxy"],
    tools_used: { get_function: 10, file_read: 10 },
    feature_areas: ["src/proxy"],
    facts_recorded: 0,
    facts_surfaced: [],
    revert_count: 0,
    rot_score: 0.1,
    token_estimate: 10000,
    branch: "main",
    ...overrides,
  };
}

describe("fact-generator", () => {
  let db: CozoDb;
  let store: TemporalFactStore;
  let testDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = TemporalFactStore.fromDb(db);
    testDir = join(tmpdir(), `unerr-factgen-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  describe("generateFromConventions", () => {
    it("creates facts for conventions with >70% adherence", async () => {
      const conventions: DetectedConvention[] = [
        {
          key: "conv-1",
          kind: "naming",
          name: "camelCase functions",
          detail: "^[a-z][a-zA-Z]*$",
          exemplarKeys: ["src/proxy/startProxy.ts"],
          frequency: 20,
          confidence: 0.85,
        },
      ];

      const result = await generateFromConventions(store, conventions);
      expect(result.created).toBe(1);
      expect(result.source).toBe("convention_detector");
      expect(result.details[0]).toContain("camelCase functions");
    });

    it("skips conventions below 70% adherence", async () => {
      const conventions: DetectedConvention[] = [
        {
          key: "conv-low",
          kind: "naming",
          name: "snake_case",
          detail: ".*",
          exemplarKeys: [],
          frequency: 10,
          confidence: 0.5,
        },
      ];

      const result = await generateFromConventions(store, conventions);
      expect(result.created).toBe(0);
    });

    it("skips conventions with too few entities", async () => {
      const conventions: DetectedConvention[] = [
        {
          key: "conv-few",
          kind: "structure",
          name: "rare pattern",
          detail: ".*",
          exemplarKeys: [],
          frequency: 2,
          confidence: 0.95,
        },
      ];

      const result = await generateFromConventions(store, conventions);
      expect(result.created).toBe(0);
    });
  });

  describe("generateFromNegativeKnowledge", () => {
    it("creates negative facts from correction entries", async () => {
      const corrections: CorrectionEntry[] = [
        {
          id: "corr-1",
          entityKey: "src/auth.ts",
          pattern: "modified-then-reverted",
          reason:
            "File src/auth.ts was modified and reverted. The approach was incorrect.",
          detectedAt: new Date().toISOString(),
          rewindEntryId: "rewind-001",
          confidence: 0.7,
        },
      ];

      const result = await generateFromNegativeKnowledge(store, corrections);
      expect(result.created).toBe(1);
      expect(result.source).toBe("negative_knowledge");

      const recalled = await store.recallByScope("src/auth.ts", 0);
      expect(recalled.length).toBe(1);
      expect(recalled[0]!.fact_type).toBe("negative");
    });
  });

  describe("generateFromCausalBridge", () => {
    it("creates episodic facts for survived changes", async () => {
      const events: CausalBridgeEvent[] = [
        {
          session_id: "sess-1",
          entity_key: "src/proxy.ts::startProxy",
          action: "survived",
          branch: "main",
          timestamp: Date.now() - 86400000,
        },
      ];

      const result = await generateFromCausalBridge(store, events);
      expect(result.created).toBe(1);
      expect(result.details[0]).toContain("survived");
    });

    it("creates negative facts for reverted changes", async () => {
      const events: CausalBridgeEvent[] = [
        {
          session_id: "sess-2",
          entity_key: "src/config.ts",
          action: "reverted",
          branch: "main",
          timestamp: Date.now() - 86400000,
        },
      ];

      const result = await generateFromCausalBridge(store, events);
      expect(result.created).toBe(1);
      expect(result.details[0]).toContain("reverted");

      const recalled = await store.recallByScope("src/config.ts", 0);
      expect(recalled[0]!.fact_type).toBe("negative");
    });
  });

  describe("generateFromSessionAnalysis", () => {
    it("detects hot files from multiple sessions", async () => {
      const sessionsDir = join(testDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });

      for (let i = 0; i < 5; i++) {
        const record = makeSessionRecord({
          session_id: `s${i}`,
          files_modified: ["src/proxy.ts", "src/auth.ts", `src/other${i}.ts`],
        });
        writeFileSync(
          join(sessionsDir, `s${i}.jsonl`),
          JSON.stringify(record) + "\n",
          "utf-8",
        );
      }

      const result = await generateFromSessionAnalysis(store, testDir);
      expect(result.created).toBeGreaterThan(0);
      expect(result.details.some((d) => d.includes("src/proxy.ts"))).toBe(true);
    });

    it("detects high-revert files", async () => {
      const sessionsDir = join(testDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });

      for (let i = 0; i < 5; i++) {
        const record = makeSessionRecord({
          session_id: `s${i}`,
          files_modified: ["src/fragile.ts"],
          revert_count: i < 3 ? 1 : 0, // 3 out of 5 sessions have reverts
        });
        writeFileSync(
          join(sessionsDir, `s${i}.jsonl`),
          JSON.stringify(record) + "\n",
          "utf-8",
        );
      }

      const result = await generateFromSessionAnalysis(store, testDir);
      const fragileDetail = result.details.find((d) =>
        d.includes("src/fragile.ts"),
      );
      expect(fragileDetail).toBeDefined();
    });

    it("returns empty when fewer than 3 sessions", async () => {
      const sessionsDir = join(testDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });

      const record = makeSessionRecord();
      writeFileSync(
        join(sessionsDir, "s1.jsonl"),
        JSON.stringify(record) + "\n",
        "utf-8",
      );

      const result = await generateFromSessionAnalysis(store, testDir);
      expect(result.created).toBe(0);
    });
  });
});
