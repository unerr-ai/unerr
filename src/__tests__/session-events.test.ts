/**
 * Tests for SessionEvents tracking and cumulative stats persistence (Task 1.4).
 *
 * Tests validate:
 *   - SessionEvents creation and counting
 *   - Event recording functions increment correct counters
 *   - totalCaughtEvents aggregation
 *   - Cumulative stats persistence and weekly reset
 *   - Cumulative stats accumulation across sessions
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CumulativeStats,
  type SessionEvents,
  createSessionEvents,
  createSessionStats,
  loadCumulativeStats,
  persistCumulativeStats,
  recordChokepointWarning,
  recordCircularDep,
  recordDeadCodeReference,
  recordSignaturePreservation,
  recordViolation,
  totalCaughtEvents,
} from "../proxy/session-stats.js";

// ── SessionEvents ─────────────────────────────────────────────────

describe("SessionEvents", () => {
  it("creates zeroed events", () => {
    const events = createSessionEvents();
    expect(events.conventionViolationsCaught).toBe(0);
    expect(events.chokepointWarningsIssued).toBe(0);
    expect(events.circularDepsDetected).toBe(0);
    expect(events.signaturePreservations).toBe(0);
    expect(events.deadCodeReferences).toBe(0);
  });

  it("totalCaughtEvents sums all event types", () => {
    const events = createSessionEvents();
    events.conventionViolationsCaught = 3;
    events.chokepointWarningsIssued = 2;
    events.circularDepsDetected = 1;
    events.signaturePreservations = 4;
    events.deadCodeReferences = 5;
    expect(totalCaughtEvents(events)).toBe(15);
  });

  it("totalCaughtEvents returns 0 for empty events", () => {
    expect(totalCaughtEvents(createSessionEvents())).toBe(0);
  });
});

// ── Event Recording ───────────────────────────────────────────────

describe("Event recording functions", () => {
  it("recordViolation increments both violationsCaught and conventionViolationsCaught", () => {
    const stats = createSessionStats();
    recordViolation(stats);
    recordViolation(stats);
    expect(stats.violationsCaught).toBe(2);
    expect(stats.events.conventionViolationsCaught).toBe(2);
  });

  it("recordChokepointWarning increments chokepointWarningsIssued", () => {
    const stats = createSessionStats();
    recordChokepointWarning(stats);
    expect(stats.events.chokepointWarningsIssued).toBe(1);
  });

  it("recordCircularDep increments circularDepsDetected", () => {
    const stats = createSessionStats();
    recordCircularDep(stats);
    recordCircularDep(stats);
    recordCircularDep(stats);
    expect(stats.events.circularDepsDetected).toBe(3);
  });

  it("recordSignaturePreservation increments signaturePreservations", () => {
    const stats = createSessionStats();
    recordSignaturePreservation(stats);
    expect(stats.events.signaturePreservations).toBe(1);
  });

  it("recordDeadCodeReference increments deadCodeReferences", () => {
    const stats = createSessionStats();
    recordDeadCodeReference(stats);
    recordDeadCodeReference(stats);
    expect(stats.events.deadCodeReferences).toBe(2);
  });

  it("events are embedded in SessionStats", () => {
    const stats = createSessionStats();
    recordViolation(stats);
    recordChokepointWarning(stats);
    recordCircularDep(stats);
    expect(totalCaughtEvents(stats.events)).toBe(3);
  });
});

// ── Cumulative Stats ──────────────────────────────────────────────

describe("Cumulative stats persistence", () => {
  let origHome: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `unerr-cumulative-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, ".unerr"), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zeroed cumulative stats on first load", () => {
    const cumulative = loadCumulativeStats();
    expect(cumulative.totalTokensSaved).toBe(0);
    expect(cumulative.totalSessions).toBe(0);
    expect(cumulative.violationsCaughtAllTime).toBe(0);
    expect(cumulative.chokepointWarningsAllTime).toBe(0);
    expect(cumulative.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("persists and accumulates session stats", () => {
    const stats1 = createSessionStats();
    stats1.toolCallsLocal = 50;
    stats1.estimatedTokensSaved = 160000;
    stats1.events.conventionViolationsCaught = 3;
    stats1.events.chokepointWarningsIssued = 1;

    const c1 = persistCumulativeStats(stats1);
    expect(c1.totalSessions).toBe(1);
    expect(c1.totalTokensSaved).toBe(160000);
    expect(c1.violationsCaughtAllTime).toBe(4); // 3 + 1

    // Second session
    const stats2 = createSessionStats();
    stats2.toolCallsLocal = 30;
    stats2.estimatedTokensSaved = 96000;
    stats2.events.conventionViolationsCaught = 2;

    const c2 = persistCumulativeStats(stats2);
    expect(c2.totalSessions).toBe(2);
    expect(c2.totalTokensSaved).toBe(256000);
    expect(c2.violationsCaughtAllTime).toBe(6);
  });

  it("resets on new week", () => {
    // Write stats with a different week
    const filePath = path.join(tmpDir, ".unerr", "cumulative-stats.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        totalTokensSaved: 500000,
        totalSessions: 10,
        weekStart: "2025-01-06", // Old week
        violationsCaughtAllTime: 50,
        chokepointWarningsAllTime: 20,
      })
    );

    const cumulative = loadCumulativeStats();
    // Should be reset since weekStart doesn't match current
    expect(cumulative.totalSessions).toBe(0);
    expect(cumulative.totalTokensSaved).toBe(0);
  });

  it("writes cumulative file to ~/.unerr/", () => {
    const stats = createSessionStats();
    stats.toolCallsLocal = 10;
    stats.estimatedTokensSaved = 32000;
    persistCumulativeStats(stats);

    const filePath = path.join(tmpDir, ".unerr", "cumulative-stats.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(
      fs.readFileSync(filePath, "utf-8")
    ) as CumulativeStats;
    expect(data.totalSessions).toBe(1);
    expect(data.totalTokensSaved).toBe(32000);
  });
});
