import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CozoDb } from "../intelligence/cozo-schema.js";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
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
  overrides: Partial<SessionSummaryRecord> = {}
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

/**
 * Persist a session summary into `<unerrDir>/metrics.db` (session_summaries) —
 * the source `generateFromSessionAnalysis` now reads (replaced the old
 * per-session `sessions/*.jsonl` files). Serializes the array/object columns
 * exactly as the production writer does.
 */
function seedSession(unerrDir: string, record: SessionSummaryRecord): void {
  openMetricsStore(unerrDir).upsertSessionSummary({
    session_id: record.session_id,
    written_at: record.written_at,
    started_at: record.started_at,
    ended_at: record.ended_at,
    duration_ms: record.duration_ms,
    tool_calls: record.tool_calls,
    chains: record.chains,
    files_modified: JSON.stringify(record.files_modified),
    entities_touched: JSON.stringify(record.entities_touched),
    tools_used: JSON.stringify(record.tools_used),
    feature_areas: JSON.stringify(record.feature_areas),
    facts_recorded: record.facts_recorded,
    facts_surfaced: JSON.stringify(record.facts_surfaced),
    revert_count: record.revert_count,
    rot_score: record.rot_score,
    token_estimate: record.token_estimate,
    branch: record.branch,
  });
}

describe("fact-generator", () => {
  let db: CozoDb;
  let store: TemporalFactStore;
  let testDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    await initFactsSchema(db);
    store = TemporalFactStore.fromDb(db);
    testDir = join(
      tmpdir(),
      `unerr-factgen-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Drop the cached metrics-store connection before removing its file so the
    // singleton doesn't hand a later test a handle to a deleted DB.
    closeMetricsStore(testDir);
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
      for (let i = 0; i < 5; i++) {
        seedSession(
          testDir,
          makeSessionRecord({
            session_id: `s${i}`,
            files_modified: ["src/proxy.ts", "src/auth.ts", `src/other${i}.ts`],
          })
        );
      }

      const result = await generateFromSessionAnalysis(store, testDir);
      expect(result.created).toBeGreaterThan(0);
      expect(result.details.some((d) => d.includes("src/proxy.ts"))).toBe(true);
    });

    it("detects high-revert files", async () => {
      for (let i = 0; i < 5; i++) {
        seedSession(
          testDir,
          makeSessionRecord({
            session_id: `s${i}`,
            files_modified: ["src/fragile.ts"],
            revert_count: i < 3 ? 1 : 0, // 3 out of 5 sessions have reverts
          })
        );
      }

      const result = await generateFromSessionAnalysis(store, testDir);
      const fragileDetail = result.details.find((d) =>
        d.includes("src/fragile.ts")
      );
      expect(fragileDetail).toBeDefined();
    });

    it("returns empty when fewer than 3 sessions", async () => {
      seedSession(testDir, makeSessionRecord());

      const result = await generateFromSessionAnalysis(store, testDir);
      expect(result.created).toBe(0);
    });
  });
});
