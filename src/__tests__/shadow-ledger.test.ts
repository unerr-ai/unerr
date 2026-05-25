/**
 * P10-TEST-04: Shadow Ledger tests — append-only JSONL intent journal.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LedgerEntry, ShadowLedger } from "../tracking/shadow-ledger.js";

let tempDir: string;
let unerrDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `unerr-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  unerrDir = join(tempDir, ".unerr");
  mkdirSync(unerrDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("ShadowLedger", () => {
  it("creates ledger directory and file on first record", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record(
      "get_function",
      { key: "abc" },
      { found: true },
      "main",
      "deadbeef"
    );

    const filePath = join(unerrDir, "ledger", "shadow.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8").trim();
    const entry = JSON.parse(content) as LedgerEntry;
    expect(entry.tool).toBe("get_function");
    expect(entry.branch).toBe("main");
    expect(entry.head_sha).toBe("deadbeef");
    expect(entry.args_summary).toEqual({ key: "abc" });
    expect(entry.result_summary).toEqual({ found: true });
  });

  it("generates unique 12-char hex IDs", () => {
    const ledger = new ShadowLedger(unerrDir);
    const e1 = ledger.record("get_function", {}, {}, "main", "aaa");
    const e2 = ledger.record("get_class", {}, {}, "main", "aaa");

    expect(e1.id).toHaveLength(12);
    expect(e2.id).toHaveLength(12);
    expect(e1.id).not.toBe(e2.id);
    expect(/^[0-9a-f]{12}$/.test(e1.id)).toBe(true);
  });

  it("assigns session ID consistent across records", () => {
    const ledger = new ShadowLedger(unerrDir);
    const e1 = ledger.record("get_function", {}, {}, "main", "aaa");
    const e2 = ledger.record("get_class", {}, {}, "main", "aaa");

    expect(e1.session_id).toBe(e2.session_id);
    expect(e1.session_id).toBe(ledger.getSessionId());
  });

  it("resumes under an injected session id (warm-restart continuity)", () => {
    const ledger = new ShadowLedger(unerrDir, { sessionId: "deadbeefcafe" });
    expect(ledger.getSessionId()).toBe("deadbeefcafe");
    const e1 = ledger.record("get_function", {}, {}, "main", "aaa");
    expect(e1.session_id).toBe("deadbeefcafe");
  });

  it("mints a fresh 12-hex id when no session id is injected", () => {
    const ledger = new ShadowLedger(unerrDir);
    expect(/^[0-9a-f]{12}$/.test(ledger.getSessionId())).toBe(true);
  });

  it("appends entries as JSONL (one JSON per line)", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record("get_function", { key: "a" }, { found: true }, "main", "aaa");
    ledger.record("get_class", { key: "b" }, { found: false }, "main", "bbb");
    ledger.record("search_code", { query: "foo" }, { count: 5 }, "main", "ccc");

    const filePath = join(unerrDir, "ledger", "shadow.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const entries = lines.map((l) => JSON.parse(l) as LedgerEntry);
    expect(entries[0]?.tool).toBe("get_function");
    expect(entries[1]?.tool).toBe("get_class");
    expect(entries[2]?.tool).toBe("search_code");
  });

  it("correlates entries within 30s window", () => {
    const ledger = new ShadowLedger(unerrDir);
    const root = ledger.record("get_function", {}, {}, "main", "aaa");
    const child = ledger.record("get_callers", {}, {}, "main", "aaa");

    // Root has null correlation_id
    expect(root.correlation_id).toBeNull();
    // Child correlates to root
    expect(child.correlation_id).toBe(root.id);
  });

  it("sync_local_diff always correlates to current root", () => {
    const ledger = new ShadowLedger(unerrDir);
    const root = ledger.record("get_function", {}, {}, "main", "aaa");
    const sync = ledger.record(
      "sync_local_diff",
      { diff: "..." },
      {},
      "main",
      "aaa"
    );

    expect(sync.correlation_id).toBe(root.id);
  });

  it("maintains in-memory buffer of recent entries", () => {
    const ledger = new ShadowLedger(unerrDir);
    for (let i = 0; i < 5; i++) {
      ledger.record(`tool_${i}`, {}, {}, "main", "aaa");
    }

    const recent = ledger.getRecentEntries(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.tool).toBe("tool_2");
    expect(recent[2]?.tool).toBe("tool_4");
  });

  it("truncates arg values longer than 200 chars", () => {
    const ledger = new ShadowLedger(unerrDir);
    const longValue = "x".repeat(500);
    const entry = ledger.record(
      "get_function",
      { content: longValue },
      {},
      "main",
      "aaa"
    );

    const truncated = entry.args_summary.content as string;
    expect(truncated.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("recovers from corrupted JSONL on startup", () => {
    // Write a file with one valid line and one corrupt line
    const ledgerDir = join(unerrDir, "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    const filePath = join(ledgerDir, "shadow.jsonl");
    const validEntry = JSON.stringify({
      id: "aabbccddeeff",
      ts: new Date().toISOString(),
      tool: "get_function",
      args_summary: {},
      result_summary: {},
      branch: "main",
      head_sha: "abc",
      session_id: "112233445566",
      correlation_id: null,
    });
    writeFileSync(filePath, `${validEntry}\n{broken json\n`, "utf-8");

    // Loading should recover — keep valid line, drop corrupt
    const ledger = new ShadowLedger(unerrDir);
    const content = readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    // Should still be able to record new entries
    const entry = ledger.record("get_class", {}, {}, "main", "def");
    expect(entry.tool).toBe("get_class");
  });

  it("loads recent entries from file into buffer on startup", () => {
    // Create a ledger with entries
    const ledger1 = new ShadowLedger(unerrDir);
    ledger1.record("get_function", {}, {}, "main", "aaa");
    ledger1.record("get_class", {}, {}, "main", "bbb");

    // Create a new ledger instance — should load entries from file
    const ledger2 = new ShadowLedger(unerrDir);
    const recent = ledger2.getRecentEntries(10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent.some((e) => e.tool === "get_function")).toBe(true);
    expect(recent.some((e) => e.tool === "get_class")).toBe(true);
  });

  it("getStats returns correct counts", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record("get_function", {}, {}, "main", "aaa");
    ledger.record("get_class", {}, {}, "main", "bbb");

    const stats = ledger.getStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.bufferSize).toBe(2);
    expect(stats.sessionId).toBe(ledger.getSessionId());
    expect(stats.lastEntryAt).toBeTruthy();
  });

  it("readAllEntries reads full file", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record("get_function", {}, {}, "main", "aaa");
    ledger.record("get_class", {}, {}, "main", "bbb");

    const all = ledger.readAllEntries();
    expect(all).toHaveLength(2);
    expect(all[0]?.tool).toBe("get_function");
    expect(all[1]?.tool).toBe("get_class");
  });

  it("getSessionEntryCount counts current session only", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record("get_function", {}, {}, "main", "aaa");
    ledger.record("get_class", {}, {}, "main", "bbb");

    expect(ledger.getSessionEntryCount()).toBe(2);
  });

  it("handles empty file gracefully", () => {
    const ledgerDir = join(unerrDir, "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, "shadow.jsonl"), "", "utf-8");

    const ledger = new ShadowLedger(unerrDir);
    expect(ledger.getRecentEntries()).toHaveLength(0);
    expect(ledger.getStats().totalEntries).toBe(0);
  });
});

describe("ShadowLedger.getLastSyncTimestamp", () => {
  it("returns 0 when no sync_local_diff recorded", () => {
    const ledger = new ShadowLedger(unerrDir);
    expect(ledger.getLastSyncTimestamp()).toBe(0);
  });

  it("returns 0 when only non-sync tools recorded", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record("get_entity", {}, {}, "main", "abc");
    ledger.record("search", {}, {}, "main", "abc");
    expect(ledger.getLastSyncTimestamp()).toBe(0);
  });

  it("returns timestamp of most recent sync_local_diff", () => {
    const ledger = new ShadowLedger(unerrDir);
    const beforeTs = Date.now();
    ledger.record("sync_local_diff", {}, {}, "main", "abc");
    const afterTs = Date.now();

    const syncTs = ledger.getLastSyncTimestamp();
    expect(syncTs).toBeGreaterThanOrEqual(beforeTs);
    expect(syncTs).toBeLessThanOrEqual(afterTs);
  });

  it("returns latest sync when multiple syncs recorded", () => {
    const ledger = new ShadowLedger(unerrDir);
    ledger.record("sync_local_diff", {}, {}, "main", "abc");
    ledger.record("get_entity", {}, {}, "main", "abc");

    const beforeSecond = Date.now();
    ledger.record("sync_local_diff", {}, {}, "main", "def");
    const afterSecond = Date.now();

    const syncTs = ledger.getLastSyncTimestamp();
    expect(syncTs).toBeGreaterThanOrEqual(beforeSecond);
    expect(syncTs).toBeLessThanOrEqual(afterSecond);
  });
});
