/**
 * End-to-end warm-restart continuity guard.
 *
 * The unit tests in session-resume-id.test.ts cover resolveResumableSessionId
 * in isolation, but the FULL path that the proxy boot actually runs —
 * detectSessionResume reading session_id off session_stats.json, then feeding
 * that snapshot into resolveResumableSessionId — was never tested. This
 * reproduces the proxy boot's two-step read against real temp files so a
 * regression in either half (e.g. detectSessionResume dropping session_id, or
 * the ledger/stats path gating) is caught.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  detectSessionResume,
  resolveResumableSessionId,
} from "../proxy/session-stats.js";

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), "unerr-resume-"));
  const stateDir = join(root, "state");
  const ledgerDir = join(root, "ledger");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  return { stateDir, ledgerDir };
}

function writeStats(stateDir: string, snapshot: Record<string, unknown>): void {
  writeFileSync(
    join(stateDir, "session_stats.json"),
    JSON.stringify(snapshot, null, 2),
    "utf-8"
  );
}

function writeLedger(ledgerDir: string, lines = 1): void {
  const body = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({ session_id: "prevsession1", turn: i })
  ).join("\n");
  writeFileSync(join(ledgerDir, "shadow.jsonl"), `${body}\n`, "utf-8");
}

describe("warm-restart continuity round-trip", () => {
  let stateDir: string;
  let ledgerDir: string;
  const now = Date.now();

  beforeEach(() => {
    ({ stateDir, ledgerDir } = makeDirs());
  });

  it("detectSessionResume surfaces session_id, resolve reuses it within window", () => {
    writeLedger(ledgerDir);
    writeStats(stateDir, {
      pid: process.pid + 1, // a different (dead) proxy
      session_id: "prevsession1",
      sessionStartedAt: new Date(now - 5 * 60_000).toISOString(),
      toolCallsLocal: 5,
      violationsCaught: 0,
      updatedAt: new Date(now - 60_000).toISOString(), // 1 min ago
    });

    const prev = detectSessionResume(stateDir, ledgerDir);
    expect(prev).not.toBeNull();
    expect(prev?.sessionId).toBe("prevsession1");
    expect(resolveResumableSessionId(prev, now)).toBe("prevsession1");
  });

  it("returns null when the previous proxy made zero tool calls (snapshot gate)", () => {
    writeLedger(ledgerDir);
    writeStats(stateDir, {
      pid: process.pid + 1,
      session_id: "prevsession1",
      sessionStartedAt: new Date(now - 60_000).toISOString(),
      toolCallsLocal: 0, // never crossed the snapshot-write gate
      updatedAt: new Date(now - 30_000).toISOString(),
    });

    const prev = detectSessionResume(stateDir, ledgerDir);
    expect(prev).toBeNull();
    expect(resolveResumableSessionId(prev, now)).toBeNull();
  });

  it("does NOT resume when the prior session is older than the window", () => {
    writeLedger(ledgerDir);
    writeStats(stateDir, {
      pid: process.pid + 1,
      session_id: "prevsession1",
      sessionStartedAt: new Date(now - 30 * 60_000).toISOString(),
      toolCallsLocal: 5,
      updatedAt: new Date(now - 15 * 60_000).toISOString(), // 15 min ago
    });

    const prev = detectSessionResume(stateDir, ledgerDir);
    expect(prev).not.toBeNull(); // detection still fires (it's a resume)
    expect(prev?.sessionId).toBe("prevsession1");
    // but ID-continuity declines — treat as a new conversation
    expect(resolveResumableSessionId(prev, now)).toBeNull();
  });

  it("returns null when shadow.jsonl is absent (no prior ledger)", () => {
    // stats present, ledger missing — detection must bail
    writeStats(stateDir, {
      pid: process.pid + 1,
      session_id: "prevsession1",
      sessionStartedAt: new Date(now - 60_000).toISOString(),
      toolCallsLocal: 5,
      updatedAt: new Date(now - 30_000).toISOString(),
    });

    const prev = detectSessionResume(stateDir, ledgerDir);
    expect(prev).toBeNull();
  });
});
