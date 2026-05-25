/**
 * Tests for the `/api/logbook/compliance` route (Fix H — directive
 * compliance ribbon). Verifies the ribbon picks up the four counter
 * pairs from `nudge-state.json` and derives ratios + consecutive miss
 * streaks correctly.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetNudgeState, updateNudgeState } from "../proxy/nudge-state.js";
import {
  buildComplianceRibbon,
  createLogbookRoutes,
} from "../server/routes/logbook.js";
import { BehaviorEventWriter } from "../tracking/behavior-events.js";
import { readNamedEvents } from "../tracking/named-events.js";

function makeUnerrDir(): { unerrDir: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "unerr-compliance-"));
  return { unerrDir: join(cwd, ".unerr"), cwd };
}

describe("buildComplianceRibbon (Fix H)", () => {
  let unerrDir: string;
  let cwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    ({ unerrDir, cwd } = makeUnerrDir());
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `cmpl-${Date.now()}-${Math.random()}`;
    _resetNudgeState(cwd);
  });

  afterEach(() => {
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("reports the four canonical counters with sane defaults on empty state", () => {
    const ribbon = buildComplianceRibbon(unerrDir, []);
    expect(ribbon.surface2.required).toBe(0);
    expect(ribbon.surface3.required).toBe(0);
    expect(ribbon.mark_intent.required).toBe(0);
    expect(ribbon.skill.required).toBe(0);
    // Empty required defaults to ratio=1 (no demand = full compliance)
    expect(ribbon.surface2.ratio).toBe(1);
  });

  it("derives Surface 2 ratio from required vs called counts", () => {
    updateNudgeState(cwd, (s) => {
      s.surface2_required_count = 10;
      s.surface2_called_count = 7;
      s.consecutive_surface2_misses = 2;
    });
    const ribbon = buildComplianceRibbon(unerrDir, []);
    expect(ribbon.surface2.required).toBe(10);
    expect(ribbon.surface2.called).toBe(7);
    expect(ribbon.surface2.ratio).toBe(0.7);
    expect(ribbon.surface2.consecutive_misses).toBe(2);
  });

  it("derives Surface 3 (turn_summary) ratio from required vs emitted", () => {
    updateNudgeState(cwd, (s) => {
      s.turn_summary_required_count = 4;
      s.turn_summary_emitted_count = 3;
      s.consecutive_receipt_misses = 1;
    });
    const ribbon = buildComplianceRibbon(unerrDir, []);
    expect(ribbon.surface3.required).toBe(4);
    expect(ribbon.surface3.called).toBe(3);
    expect(ribbon.surface3.ratio).toBe(0.75);
    expect(ribbon.surface3.consecutive_misses).toBe(1);
  });

  it("derives mark_intent ratio from required vs compliant", () => {
    updateNudgeState(cwd, (s) => {
      s.mark_intent_required_count = 5;
      s.mark_intent_compliant_count = 5;
    });
    const ribbon = buildComplianceRibbon(unerrDir, []);
    expect(ribbon.mark_intent.ratio).toBe(1);
  });

  // §10.7 — Surface 4 ribbon row deleted (merged into Surface 3 receipt).
  // The Surface 4 ratio test that previously lived here has been removed
  // along with the underlying ComplianceRibbon.surface4 field.
});

describe("/api/logbook/compliance route (Fix H)", () => {
  let unerrDir: string;
  let cwd: string;
  let originalSessionId: string | undefined;

  beforeEach(() => {
    ({ unerrDir, cwd } = makeUnerrDir());
    originalSessionId = process.env.UNERR_SESSION_ID;
    process.env.UNERR_SESSION_ID = `cmpl-route-${Date.now()}-${Math.random()}`;
    _resetNudgeState(cwd);
  });

  afterEach(() => {
    if (originalSessionId === undefined) {
      Reflect.deleteProperty(process.env, "UNERR_SESSION_ID");
    } else {
      process.env.UNERR_SESSION_ID = originalSessionId;
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns a 200 with the four-counter ribbon under data", async () => {
    updateNudgeState(cwd, (s) => {
      s.surface2_required_count = 8;
      s.surface2_called_count = 6;
    });
    const app = createLogbookRoutes({ unerrDir });
    const res = await app.request("/compliance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { surface2: { ratio: number } };
      _meta: { latency_ms: number };
    };
    expect(body.data.surface2.ratio).toBe(0.75);
    expect(typeof body._meta.latency_ms).toBe("number");
  });
});
