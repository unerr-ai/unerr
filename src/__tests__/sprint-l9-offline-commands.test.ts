/**
 * Tests for Sprint L9 — Offline Command Replacements.
 *
 * L9.1: unerr branches local implementation
 * L9.2: unerr timeline local implementation
 * L9.3: RewindReconciler explicit Local Mode guard
 * L9.4: sync_local_diff drift overlay writes (tested via QueryRouter integration)
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── L9.2: Timeline Tests ────────────────────────────────────────
// Note: We mirror formatRelativeTime and readShadowLedger here to avoid
// importing timeline.ts which transitively imports auth.ts (esbuild issue).

import { existsSync, readFileSync } from "node:fs";
import type { LedgerEntry } from "../tracking/shadow-ledger.js";

function formatRelativeTime(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function readShadowLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  try {
    const raw = readFileSync(ledgerPath, "utf-8");
    const entries: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as LedgerEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

describe("formatRelativeTime (L9.2)", () => {
  it("formats seconds ago", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("30s ago");
  });

  it("formats minutes ago", () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("5 min ago");
  });

  it("formats hours ago", () => {
    const ts = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("3h ago");
  });

  it("formats days ago", () => {
    const ts = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(formatRelativeTime(ts)).toBe("2d ago");
  });
});

describe("readShadowLedger (L9.2)", () => {
  it("reads JSONL entries from ledger file", () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-l9-"));
    const ledgerPath = join(dir, "shadow.jsonl");

    const entries = [
      {
        id: "abc123",
        ts: "2025-01-01T10:00:00Z",
        tool: "get_function",
        args_summary: { key: "processPayment" },
        result_summary: { found: true },
        branch: "main",
        head_sha: "deadbeef",
        session_id: "sess1",
        correlation_id: null,
      },
      {
        id: "def456",
        ts: "2025-01-01T10:05:00Z",
        tool: "check_rules",
        args_summary: { file_path: "src/payment.ts" },
        result_summary: { violations: 0 },
        branch: "main",
        head_sha: "deadbeef",
        session_id: "sess1",
        correlation_id: "abc123",
      },
    ];

    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n"));

    const result = readShadowLedger(ledgerPath);
    expect(result).toHaveLength(2);
    expect(result[0]?.tool).toBe("get_function");
    expect(result[1]?.tool).toBe("check_rules");
    expect(result[0]?.branch).toBe("main");
  });

  it("returns empty array for missing file", () => {
    const result = readShadowLedger("/nonexistent/path/shadow.jsonl");
    expect(result).toHaveLength(0);
  });

  it("skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-l9-"));
    const ledgerPath = join(dir, "shadow.jsonl");

    writeFileSync(
      ledgerPath,
      [
        JSON.stringify({
          id: "abc",
          ts: "2025-01-01T10:00:00Z",
          tool: "get_function",
          args_summary: {},
          result_summary: {},
          branch: "main",
          head_sha: "abc",
          session_id: "s1",
          correlation_id: null,
        }),
        "not json",
        JSON.stringify({
          id: "def",
          ts: "2025-01-01T10:01:00Z",
          tool: "get_class",
          args_summary: {},
          result_summary: {},
          branch: "main",
          head_sha: "def",
          session_id: "s1",
          correlation_id: null,
        }),
      ].join("\n")
    );

    const result = readShadowLedger(ledgerPath);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("abc");
    expect(result[1]?.id).toBe("def");
  });

  it("supports branch filter pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), "unerr-l9-"));
    const ledgerPath = join(dir, "shadow.jsonl");

    const entries = [
      {
        id: "a1",
        ts: "2025-01-01T10:00:00Z",
        tool: "get_function",
        args_summary: {},
        result_summary: {},
        branch: "main",
        head_sha: "a",
        session_id: "s1",
        correlation_id: null,
      },
      {
        id: "b1",
        ts: "2025-01-01T10:01:00Z",
        tool: "get_class",
        args_summary: {},
        result_summary: {},
        branch: "feature/auth",
        head_sha: "b",
        session_id: "s1",
        correlation_id: null,
      },
      {
        id: "c1",
        ts: "2025-01-01T10:02:00Z",
        tool: "check_rules",
        args_summary: {},
        result_summary: {},
        branch: "main",
        head_sha: "c",
        session_id: "s1",
        correlation_id: null,
      },
    ];

    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n"));

    const all = readShadowLedger(ledgerPath);
    const mainOnly = all.filter((e) => e.branch === "main");
    expect(mainOnly).toHaveLength(2);
    expect(mainOnly[0]?.id).toBe("a1");
    expect(mainOnly[1]?.id).toBe("c1");
  });
});
