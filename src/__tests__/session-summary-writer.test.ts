import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import {
  type SessionWriterContext,
  readLastSession,
  writeSessionSummary,
} from "../tracking/session-summary-writer.js";
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
    session_id: "test-session",
    correlation_id: null,
    ...overrides,
  };
}

describe("session-summary-writer", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `unerr-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      closeMetricsStore(testDir);
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe("writeSessionSummary", () => {
    it("upserts a session summary event into the JSONL event store", () => {
      const ctx: SessionWriterContext = {
        sessionId: "test-session-001",
        entries: [
          makeEntry({
            tool: "get_function",
            args_summary: { key: "src/a.ts::fn" },
          }),
          makeEntry({
            tool: "get_callers",
            args_summary: { key: "src/a.ts::fn" },
          }),
          makeEntry({ tool: "record_fact" }),
        ],
        factsRecordedIds: ["fact-abc"],
        factsSurfacedIds: ["fact-xyz"],
        rotScore: 0.15,
        tokenEstimate: 8000,
      };

      const record = writeSessionSummary(testDir, ctx);
      expect(record).not.toBeNull();
      expect(record!.session_id).toBe("test-session-001");
      expect(record!.tool_calls).toBe(3);
      expect(record!.facts_recorded).toBe(1);
      expect(record!.rot_score).toBe(0.15);
      expect(record!.token_estimate).toBe(8000);

      const row = openMetricsStore(testDir).sessionSummary("test-session-001");
      expect(row).not.toBeNull();
      expect(row!.session_id).toBe("test-session-001");
      expect(row!.tool_calls).toBe(3);
      expect(JSON.parse(row!.files_modified)).toEqual(
        expect.arrayContaining([])
      );
    });

    it("writes last_session.json pointer", () => {
      const ctx: SessionWriterContext = {
        sessionId: "sess-pointer-test",
        entries: [makeEntry()],
        factsRecordedIds: [],
        factsSurfacedIds: [],
        rotScore: 0,
        tokenEstimate: 1000,
      };

      writeSessionSummary(testDir, ctx);

      const pointerPath = join(testDir, "state", "last_session.json");
      expect(existsSync(pointerPath)).toBe(true);

      const pointer = JSON.parse(readFileSync(pointerPath, "utf-8"));
      expect(pointer.session_id).toBe("sess-pointer-test");
    });

    it("returns null for empty entries", () => {
      const ctx: SessionWriterContext = {
        sessionId: "empty",
        entries: [],
        factsRecordedIds: [],
        factsSurfacedIds: [],
        rotScore: 0,
        tokenEstimate: 0,
      };

      const record = writeSessionSummary(testDir, ctx);
      expect(record).toBeNull();
    });

    it("extracts files and entities from entries", () => {
      const ctx: SessionWriterContext = {
        sessionId: "extraction-test",
        entries: [
          makeEntry({ args_summary: { file_path: "src/auth.ts" } }),
          makeEntry({ args_summary: { key: "src/proxy.ts::startProxy" } }),
        ],
        factsRecordedIds: [],
        factsSurfacedIds: [],
        rotScore: 0,
        tokenEstimate: 2000,
      };

      const record = writeSessionSummary(testDir, ctx);
      expect(record!.files_modified).toContain("src/auth.ts");
      expect(record!.entities_touched).toContain("src/proxy.ts::startProxy");
    });
  });

  describe("readLastSession", () => {
    it("reads written last_session.json", () => {
      const ctx: SessionWriterContext = {
        sessionId: "read-test",
        entries: [makeEntry(), makeEntry()],
        factsRecordedIds: ["f1"],
        factsSurfacedIds: [],
        rotScore: 0.5,
        tokenEstimate: 5000,
      };

      writeSessionSummary(testDir, ctx);

      const last = readLastSession(testDir);
      expect(last).not.toBeNull();
      expect(last!.session_id).toBe("read-test");
      expect(last!.tool_calls).toBe(2);
    });

    it("returns null when no prior session", () => {
      const last = readLastSession(testDir);
      expect(last).toBeNull();
    });
  });
});
