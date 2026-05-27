/**
 * Sprint BA-2: Quality Compound tests.
 *
 * Tests for:
 *   BA-2.1 — Incomplete Work Detection (identity + empty/persistence contract)
 *
 * The live broken-callers detection path is covered end-to-end by
 * incomplete-work-reconcile.test.ts, behavior-firing-e2e.test.ts, and
 * session-persistence.test.ts. This file keeps the dependency-free identity and
 * empty-state contract checks.
 *
 * (BA-2.2 Convention Drift, BA-2.3 Auto-Documentation, and BA-2.1's original
 * shadow-ledger detectors — orphaned imports + untested exports — were retired
 * in the 2026-05 behavior-automation audit: none fired in production. Their
 * tests were removed with them.)
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ToolCallContext } from "../behaviors/framework.js";
import { IncompleteWorkDetector } from "../behaviors/incomplete-work.js";
import type { EditImpactGraph } from "../intelligence/edit-impact.js";
import type {
  CozoGraphStore,
  LocalEntity,
} from "../intelligence/local-graph.js";
import {
  BehaviorEventWriter,
  readBehaviorEvents,
} from "../tracking/behavior-events.js";
import { closeMetricsStore } from "../tracking/metrics-store.js";
import { recordEdit } from "../tracking/session-edit-log.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `unerr-test-ba2-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "__session_end__",
    args: {},
    sessionId: "test-session",
    ...overrides,
  };
}

// ── Fixtures for the broken-callers telemetry path ──────────────────
// `pay` lives in src/pay.ts; checkout + refund call it. A signature edit
// to pay.ts with neither caller touched produces one broken-callers item.

function entity(partial: Partial<LocalEntity> & { name: string }): LocalEntity {
  return {
    key: partial.key ?? `e:${partial.name}`,
    kind: partial.kind ?? "function",
    name: partial.name,
    file_path: partial.file_path ?? `src/${partial.name}.ts`,
    start_line: partial.start_line ?? 1,
    end_line: partial.end_line ?? 10,
    signature: partial.signature ?? `function ${partial.name}()`,
    body: partial.body ?? "",
    fan_in: partial.fan_in ?? 0,
    fan_out: partial.fan_out ?? 0,
    risk_level: partial.risk_level ?? "normal",
    community: partial.community ?? -1,
  };
}

class FakeImpactGraph implements EditImpactGraph {
  constructor(
    private readonly byFile: Map<string, LocalEntity[]>,
    private readonly callers: Map<string, LocalEntity[]>
  ) {}
  async getEntitiesByFile(filePath: string): Promise<LocalEntity[]> {
    return this.byFile.get(filePath) ?? [];
  }
  async getCallersOf(entityKey: string): Promise<LocalEntity[]> {
    return this.callers.get(entityKey) ?? [];
  }
}

function payGraph(): FakeImpactGraph {
  const pay = entity({ name: "pay", file_path: "src/pay.ts" });
  const checkout = entity({ name: "checkout", file_path: "src/checkout.ts" });
  const refund = entity({ name: "refund", file_path: "src/refund.ts" });
  return new FakeImpactGraph(
    new Map([["src/pay.ts", [pay]]]),
    new Map([["e:pay", [checkout, refund]]])
  );
}

// ── BA-2.1: Incomplete Work Detection ───────────────────────────

describe("Incomplete Work Detection (BA-2.1)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    // Release any metrics.db handle the telemetry tests opened. No-op when
    // the test never created a store.
    closeMetricsStore(join(tmpDir, ".unerr"));
  });

  describe("Behavior Identity", () => {
    it("has correct id and hooks", () => {
      const detector = new IncompleteWorkDetector();
      expect(detector.id).toBe("incomplete_work");
      expect(detector.hooks).toContain("session_end");
      expect(detector.defaultLevel).toBe("suggestion");
    });
  });

  describe("Empty Session", () => {
    it("returns null when there is no edit-log to reconcile", async () => {
      const detector = new IncompleteWorkDetector();
      detector.setUnerrDir(tmpDir);

      const output = await detector.onSessionEnd(makeCtx());
      expect(output).toBeNull();
    });
  });

  describe("Persistence", () => {
    it("readPersistedItems returns empty array when no file exists", () => {
      const items = IncompleteWorkDetector.readPersistedItems(
        join(tmpDir, "nonexistent")
      );
      expect(items).toEqual([]);
    });
  });

  describe("Telemetry (incomplete_work_flagged)", () => {
    it("records a behavior_event when broken callers are flagged at session end", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });

      // Seed the session edit-log with a signature change to pay.ts; leave
      // both callers (checkout, refund) untouched this session.
      recordEdit(unerrDir, {
        ts: new Date().toISOString(),
        file_path: "src/pay.ts",
        old_content: "export function pay(a) {",
        new_content: "export function pay(a, b) {",
      });

      const sid = "telemetry-session";
      const detector = new IncompleteWorkDetector();
      detector.setUnerrDir(unerrDir);
      detector.attachGraph(payGraph() as unknown as CozoGraphStore);
      detector.setBehaviorEvents(new BehaviorEventWriter(unerrDir, sid));

      const output = await detector.onSessionEnd(makeCtx({ sessionId: sid }));
      expect(output).not.toBeNull();

      const flagged = readBehaviorEvents(unerrDir, { session_id: sid }).filter(
        (r) => r.type === "incomplete_work_flagged"
      );
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.detail?.items).toBe(1);
      expect(flagged[0]!.detail?.high_severity).toBe(1);
      expect(flagged[0]!.detail?.entities).toEqual(["pay"]);
    });

    it("records no event when there is no edit-log to reconcile", async () => {
      const unerrDir = join(tmpDir, ".unerr");
      mkdirSync(unerrDir, { recursive: true });

      const sid = "empty-session";
      const detector = new IncompleteWorkDetector();
      detector.setUnerrDir(unerrDir);
      detector.attachGraph(payGraph() as unknown as CozoGraphStore);
      detector.setBehaviorEvents(new BehaviorEventWriter(unerrDir, sid));

      const output = await detector.onSessionEnd(makeCtx({ sessionId: sid }));
      expect(output).toBeNull();
      expect(readBehaviorEvents(unerrDir, { session_id: sid })).toEqual([]);
    });
  });
});
