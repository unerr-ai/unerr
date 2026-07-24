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

    // ── session_files plumbing (marker-free continuity) ──────────────

    it("populates modified_files from timelineStore.getSessionFiles when provided", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const mockTimelineStore = {
        async getSessionFiles(sessionId: string) {
          expect(sessionId).toBe("test-session");
          return ["src/payment/gateway.ts", "src/session.ts"];
        },
      };

      const payload = await generateSessionResumePayload(
        testDir,
        mockTimelineStore
      );
      expect(payload!.modified_files).toEqual([
        "src/payment/gateway.ts",
        "src/session.ts",
      ]);
    });

    it("returns empty modified_files when timelineStore omitted", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const payload = await generateSessionResumePayload(testDir);
      expect(payload!.modified_files).toEqual([]);
    });

    it("gracefully handles timelineStore.getSessionFiles throwing", async () => {
      const record = makeSessionRecord();
      writeLastSession(testDir, record);

      const mockTimelineStore = {
        async getSessionFiles() {
          throw new Error("timeline.db unavailable");
        },
      };

      const payload = await generateSessionResumePayload(
        testDir,
        mockTimelineStore
      );
      // Resume payload still returned; modified_files just empty.
      expect(payload).not.toBeNull();
      expect(payload!.modified_files).toEqual([]);
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
