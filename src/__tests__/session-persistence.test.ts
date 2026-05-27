import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSessionResumePayload } from "../proxy/session-persistence.js";
import type { SessionSummaryRecord } from "../tracking/session-summary-writer.js";

function writeLastSession(
  unerrDir: string,
  record: SessionSummaryRecord
): void {
  const stateDir = join(unerrDir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "last_session.json"),
    JSON.stringify(record),
    "utf-8"
  );
}

function makeSessionRecord(
  overrides: Partial<SessionSummaryRecord> = {}
): SessionSummaryRecord {
  return {
    session_id: "test-session",
    written_at: new Date().toISOString(),
    started_at: new Date(Date.now() - 3600000).toISOString(),
    ended_at: new Date(Date.now() - 60000).toISOString(), // 1 min ago
    duration_ms: 3540000,
    tool_calls: 25,
    chains: 8,
    files_modified: ["src/auth.ts", "src/proxy.ts", "src/config.ts"],
    entities_touched: ["src/auth.ts::login", "src/proxy.ts::startProxy"],
    tools_used: { get_function: 10, get_callers: 5, file_read: 10 },
    feature_areas: ["src/auth"],
    facts_recorded: 2,
    facts_surfaced: ["fact-1", "fact-2"],
    revert_count: 1,
    rot_score: 0.2,
    token_estimate: 15000,
    branch: "main",
    ...overrides,
  };
}

describe("session-persistence", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `unerr-persist-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  describe("generateSessionResumePayload", () => {
    it("returns payload for recent session", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload).not.toBeNull();
      expect(payload!.session_resumed).toBe(true);
      expect(payload!.previous_session.session_id).toBe("test-session");
      expect(payload!.previous_session.tool_calls).toBe(25);
      expect(payload!.continuity.staleness).toBe("fresh");
      expect(payload!.continuity.hot_files.length).toBeGreaterThan(0);
    });

    it("returns null when no prior session", async () => {
      const payload = await generateSessionResumePayload(testDir);
      expect(payload).toBeNull();
    });

    it("returns null for sessions older than 24h", async () => {
      const record = makeSessionRecord({
        ended_at: new Date(Date.now() - 25 * 3600000).toISOString(),
      });
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload).toBeNull();
    });

    it("marks staleness as 'warm' for sessions 4-24h old", async () => {
      const record = makeSessionRecord({
        ended_at: new Date(Date.now() - 8 * 3600000).toISOString(),
      });
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload).not.toBeNull();
      expect(payload!.continuity.staleness).toBe("warm");
    });

    it("includes revert warning in incomplete hint", async () => {
      const record = makeSessionRecord({ revert_count: 3 });
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload!.continuity.incomplete_hint).toContain("revert");
    });

    it("includes hot files from previous session", async () => {
      const record = makeSessionRecord({
        files_modified: ["src/a.ts", "src/b.ts", "src/c.ts"],
      });
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload!.continuity.hot_files).toContain("src/a.ts");
    });

    it("recalls facts when factStore is provided", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const mockFactStore = {
        async recallByScope(scope: string) {
          if (scope === "src/auth.ts") {
            return [
              {
                fact_id: "f1",
                fact_type: "semantic" as const,
                scope: "src/auth.ts",
                subject: "auth",
                content: "Auth uses JWT",
                base_confidence: 0.9,
                effective_confidence: 0.85,
                reinforcement_count: 3,
                created_at: Date.now(),
                last_reinforced_at: Date.now(),
                last_contradicted_at: 0,
                source: "agent_explicit" as const,
              },
            ];
          }
          return [];
        },
      };

      const payload = await generateSessionResumePayload(
        testDir,
        mockFactStore
      );
      expect(payload!.recalled_facts.length).toBeGreaterThan(0);
      expect(payload!.recalled_facts[0]!.content).toBe("Auth uses JWT");
    });

    it("returns empty recalled_facts when factStore is null", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir, null);
      expect(payload!.recalled_facts).toEqual([]);
    });

    // ── Fix K — timelineStore plumbing ──────────────────────────────

    it("populates open_blockers from timelineStore when provided", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const mockTimelineStore = {
        async listMarkers(opts: {
          sessionId?: string;
          type?: string;
          limit?: number;
        }) {
          if (opts.type === "mark_intent") return [];
          // Simulate two open blockers + one resolution that points at
          // one of them, so only one blocker remains "open".
          return [
            {
              marker_id: "b1",
              type: "mark_blocker",
              text: "PaymentGateway has 8 callers — refactor blocked",
              session_id: "test-session",
              turn_id: "t1",
              ts: Date.now() - 1000,
              blocker_ref: "",
              file_path: "src/payment/gateway.ts",
            },
            {
              marker_id: "b2",
              type: "mark_blocker",
              text: "session_id collision",
              session_id: "test-session",
              turn_id: "t2",
              ts: Date.now() - 2000,
              blocker_ref: "",
              file_path: "src/session.ts",
            },
            {
              marker_id: "r1",
              type: "mark_resolution",
              text: "resolved by patch",
              session_id: "test-session",
              turn_id: "t3",
              ts: Date.now() - 500,
              blocker_ref: "b2",
              file_path: "src/session.ts",
            },
          ];
        },
      };

      const payload = await generateSessionResumePayload(
        testDir,
        null,
        mockTimelineStore
      );
      expect(payload!.open_blockers).toBeDefined();
      expect(payload!.open_blockers!.length).toBe(1);
      expect(payload!.open_blockers![0]!.marker_id).toBe("b1");
      expect(payload!.open_blockers![0]!.file_path).toBe(
        "src/payment/gateway.ts"
      );
    });

    it("populates last_intents from timelineStore filtered by prior session", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const mockTimelineStore = {
        async listMarkers(opts: {
          sessionId?: string;
          type?: string;
          limit?: number;
        }) {
          if (opts.type === "mark_intent") {
            expect(opts.sessionId).toBe("test-session");
            return [
              {
                marker_id: "i1",
                type: "mark_intent",
                text: "wire fact-store recall into resume strip",
                session_id: "test-session",
                turn_id: "t1",
                ts: Date.now(),
                blocker_ref: "",
                file_path: "",
              },
            ];
          }
          return [];
        },
      };

      const payload = await generateSessionResumePayload(
        testDir,
        null,
        mockTimelineStore
      );
      expect(payload!.last_intents).toBeDefined();
      expect(payload!.last_intents!.length).toBe(1);
      expect(payload!.last_intents![0]!.text).toContain(
        "wire fact-store recall"
      );
    });

    it("returns empty open_blockers + last_intents when timelineStore omitted", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload!.open_blockers).toEqual([]);
      expect(payload!.last_intents).toEqual([]);
    });

    it("gracefully handles timelineStore.listMarkers throwing", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const mockTimelineStore = {
        async listMarkers() {
          throw new Error("timeline.db unavailable");
        },
      };

      const payload = await generateSessionResumePayload(
        testDir,
        null,
        mockTimelineStore
      );
      // Resume payload still returned; new fields just empty.
      expect(payload).not.toBeNull();
      expect(payload!.open_blockers).toEqual([]);
      expect(payload!.last_intents).toEqual([]);
    });

    // ── P2.2 — broken callers round-trip from incomplete-work.json ──────

    it("surfaces broken_callers persisted by the prior session's reconcile", async () => {
      writeLastSession(testDir, makeSessionRecord());
      // Shape written by IncompleteWorkDetector.persistItems.
      writeFileSync(
        join(testDir, "state", "incomplete-work.json"),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          items: [
            {
              severity: "high",
              type: "broken_callers",
              entity: "pay",
              detail: "Signature changed but 2 caller(s) not updated",
              remaining: ["src/checkout.ts:checkout", "src/refund.ts:refund"],
              impact: "Callers will fail at runtime or compile time",
            },
            {
              severity: "medium",
              type: "orphaned_import",
              detail: "unrelated",
              impact: "noise",
            },
          ],
        }),
        "utf-8"
      );

      const payload = await generateSessionResumePayload(testDir);
      expect(payload!.broken_callers).toBeDefined();
      // Only the broken_callers item is lifted — orphaned_import is ignored.
      expect(payload!.broken_callers!.length).toBe(1);
      expect(payload!.broken_callers![0]!.entity).toBe("pay");
      expect(payload!.broken_callers![0]!.callers).toEqual([
        "src/checkout.ts:checkout",
        "src/refund.ts:refund",
      ]);
    });

    it("returns empty broken_callers when no incomplete-work.json exists", async () => {
      writeLastSession(testDir, makeSessionRecord());
      const payload = await generateSessionResumePayload(testDir);
      expect(payload!.broken_callers).toEqual([]);
    });
  });
});
