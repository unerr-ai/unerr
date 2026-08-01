import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import {
  buildCostEconomicsReport,
  renderCostEconomicsReport,
} from "../tracking/cost-economics-report.js";
import {
  closeMetricsStore,
  openMetricsStore,
} from "../tracking/metrics-store.js";
import { emitDelegationSavings } from "../tracking/savings-events.js";

/** Minimal transcript row; each test overrides the token counters it cares about. */
function row(
  sessionId: string,
  turn: number,
  tokens: Partial<Record<string, number>> = {}
) {
  return {
    session_id: sessionId,
    native_session_id: null,
    turn,
    agent: "claude-code",
    role: "assistant",
    text: null,
    tools: null,
    files: null,
    model: "claude-fable-5",
    tokens_input: 0,
    tokens_output: 0,
    tokens_cache_create: 0,
    tokens_cache_read: 0,
    ts: new Date(2026, 0, 1, 0, 0, turn).toISOString(),
    ...tokens,
  };
}

function captureStderr() {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    text: () => spy.mock.calls.map((c) => String(c[0])).join(""),
    restore: () => spy.mockRestore(),
  };
}

describe("cost economics report (terminal-only)", () => {
  let root: string;
  let dir: string;
  const savedSid = process.env.UNERR_SESSION_ID;

  beforeEach(() => {
    root = join(os.tmpdir(), `unerr-costecon-${Date.now()}-${Math.random()}`);
    dir = join(root, ".unerr");
    mkdirSync(join(dir, "state"), { recursive: true });
    // readProxySessionId prefers the env var over the file — clear it so
    // these tests exercise the `.unerr/state/session.id` file path, not
    // whatever real session this test process happens to inherit.
    process.env.UNERR_SESSION_ID = "";
  });

  afterEach(() => {
    closeMetricsStore(dir);
    rmSync(root, { recursive: true, force: true });
    if (savedSid === undefined)
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    else process.env.UNERR_SESSION_ID = savedSid;
  });

  it("returns null when no session id has been written yet", () => {
    expect(buildCostEconomicsReport(dir)).toBeNull();
  });

  it("returns null when the resolved session has no transcript rows yet", () => {
    writeFileSync(join(dir, "state", "session.id"), "sess-empty");
    expect(buildCostEconomicsReport(dir)).toBeNull();
  });

  it("degrades to null on a corrupt transcript cache — never throws", () => {
    writeFileSync(join(dir, "state", "session.id"), "sess-corrupt");
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(
      join(dir, "cache", "transcripts.jsonl"),
      "not json at all\n{broken\n"
    );
    expect(() => buildCostEconomicsReport(dir)).not.toThrow();
    expect(buildCostEconomicsReport(dir)).toBeNull();
  });

  it("computes cache metrics and delegation share for a populated session", () => {
    const sessionId = "sess-pop";
    writeFileSync(join(dir, "state", "session.id"), sessionId);

    const store = openMetricsStore(dir);
    // Turn 1 writes 1000 tokens into cache with 200 fresh input.
    store.upsertAgentTranscript(
      row(sessionId, 1, {
        tokens_input: 200,
        tokens_cache_create: 1000,
        tokens_output: 50,
      })
    );
    // Turns 2-3 read that prefix back.
    store.upsertAgentTranscript(
      row(sessionId, 2, { tokens_input: 100, tokens_cache_read: 1000 })
    );
    store.upsertAgentTranscript(
      row(sessionId, 3, { tokens_input: 100, tokens_cache_read: 2000 })
    );

    const writer = new BehaviorEventWriter(dir, sessionId);
    emitDelegationSavings(writer, {
      session_id: sessionId,
      delegable_class: "recon",
      sweep: false,
      tier: "worker",
    });
    emitDelegationSavings(writer, {
      session_id: sessionId,
      delegable_class: "docs",
      sweep: false,
      tier: "junior",
    });

    const report = buildCostEconomicsReport(dir);
    expect(report).not.toBeNull();
    expect(report?.turns).toBe(3);
    // 3000 / (3000 + 400) rounded
    expect(report?.cacheHitRatePct).toBe(88);
    // 3000 / 1000
    expect(report?.rereadAmplification).toBeCloseTo(3, 6);
    expect(report?.delegationCounts.worker).toBe(1);
    expect(report?.delegationCounts.junior).toBe(1);
    expect(report?.delegationTotal).toBe(2);
    // 2 / (2 + 3)
    expect(report?.delegatedSharePct).toBe(40);

    const out = captureStderr();
    renderCostEconomicsReport(report);
    const text = out.text();
    out.restore();
    expect(text).toContain("88%");
    expect(text).toContain("3.0x");
    expect(text).toContain("2 sub-agent runs");
    expect(text).toContain("40% of turns delegated");
    expect(text).toContain("worker");
    expect(text).toContain("junior");
  });

  it("says '0 sub-agent runs' plainly when no delegation events exist", () => {
    const sessionId = "sess-nodel";
    writeFileSync(join(dir, "state", "session.id"), sessionId);
    const store = openMetricsStore(dir);
    store.upsertAgentTranscript(
      row(sessionId, 1, { tokens_input: 100, tokens_output: 20 })
    );

    const report = buildCostEconomicsReport(dir);
    expect(report?.delegationTotal).toBe(0);

    const out = captureStderr();
    renderCostEconomicsReport(report ?? null);
    const text = out.text();
    out.restore();
    expect(text).toContain("0 sub-agent runs");
  });

  it("renders one 'no session data yet' line and never throws when report is null", () => {
    const out = captureStderr();
    expect(() => renderCostEconomicsReport(null)).not.toThrow();
    const text = out.text();
    out.restore();
    expect(text).toContain("no session data yet");
  });
});
